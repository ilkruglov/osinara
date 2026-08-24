/**
 * User-facing composition of a Telegram approval message.
 *
 * Exports:
 * - `buildApprovalMessage`: fixed order of header, verified facts, agent purpose and consequence.
 * - `genericApprovalFacts`: bounded readable fields for a tool without a reviewed description.
 * - `googleWorkspaceFacts`: decoded service, command, flags and parameters plus the exact command.
 *
 * Key constructs:
 * - Facts are derived from the same input that will execute, so the text cannot describe one action
 *   while another runs. The agent contributes only a labelled purpose line, never a fact.
 * - Everything is plain text: introducing Telegram markup here would add an escaping failure mode
 *   to the one message the owner's authorization depends on.
 */
import { AppError } from "../app-error.js";

const CONSEQUENCE = "Действие будет выполнено один раз. Автоматического повтора при ошибке не будет.";
const PURPOSE_MAX_CHARACTERS = 300;
const GENERIC_FACT_LIMIT = 8;
const GENERIC_VALUE_MAX_CHARACTERS = 180;

export interface ApprovalMessageInput {
  actionLabel: string | null;
  consequence?: string;
  facts: readonly string[];
  /** Model-authored purpose. Untrusted text: labelled, flattened and bounded before display. */
  reason?: unknown;
}

/** Strips control characters and newlines so a model cannot restructure the message. */
function flatten(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function purposeLine(reason: unknown): string[] {
  if (typeof reason !== "string") return [];
  const text = flatten(reason);
  if (!text) return [];
  const bounded = text.length <= PURPOSE_MAX_CHARACTERS
    ? text
    : `${text.slice(0, PURPOSE_MAX_CHARACTERS - 1).trimEnd()}…`;
  return [`Зачем: ${bounded}`];
}

export function buildApprovalMessage(input: ApprovalMessageInput): string {
  // Reviewed labels are authored without trailing punctuation; multi-sentence ones need it back.
  // An undescribed action stays neutral: internal tool names are never shown to the user.
  const header = input.actionLabel
    ? `Подтверждение: ${/[.!?]$/u.test(input.actionLabel) ? input.actionLabel : `${input.actionLabel}.`}`
    : "Подтверждение: выполнение действия.";
  return [
    header,
    ...(input.facts.length ? [input.facts.join("\n")] : []),
    ...purposeLine(input.reason),
    input.consequence ?? CONSEQUENCE,
  ].join("\n\n");
}

function readableScalar(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const text = flatten(value);
  if (!text) return null;
  return text.length <= GENERIC_VALUE_MAX_CHARACTERS
    ? text
    : `${text.slice(0, GENERIC_VALUE_MAX_CHARACTERS - 1).trimEnd()}…`;
}

export function genericApprovalFacts(input: Record<string, unknown>): string[] {
  // A tool without a reviewed description still has to say something concrete, so scalar fields of
  // the real input are shown. Structures stay hidden: they are where internal shapes leak.
  const facts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (facts.length === GENERIC_FACT_LIMIT) break;
    const readable = readableScalar(value);
    if (readable !== null) facts.push(`${key}: ${readable}`);
  }
  return facts;
}

function requireArgv(input: Record<string, unknown>): string[] {
  const argv = input.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === "string")) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось показать параметры команды Google Workspace",
    );
  }
  return argv;
}

function serviceLabel(service: string): string {
  return service.charAt(0).toUpperCase() + service.slice(1);
}

/** Renders `--flag value` pairs as readable lines; `--params` is decoded separately. */
function flagFacts(argv: readonly string[]): string[] {
  const facts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--") || item === "--params") continue;
    const value = argv[index + 1];
    const readable = value === undefined || value.startsWith("--")
      ? "да"
      : readableScalar(value);
    if (readable !== null) facts.push(`${item.slice(2)}: ${readable}`);
  }
  return facts;
}

function decodedParameterFacts(argv: readonly string[]): string[] {
  const index = argv.indexOf("--params");
  const raw = index === -1 ? undefined : argv[index + 1];
  if (raw === undefined) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // An undecodable payload is not an error here: the exact command below still shows it verbatim.
    return [];
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return [];
  return genericApprovalFacts(decoded as Record<string, unknown>);
}

export function googleWorkspaceFacts(input: Record<string, unknown>): string[] {
  const argv = requireArgv(input);
  const [service, ...rest] = argv;
  const flagIndex = rest.findIndex((item) => item.startsWith("-"));
  const command = (flagIndex === -1 ? rest : rest.slice(0, flagIndex)).join(" ");
  return [
    `Сервис: ${serviceLabel(service!)}`,
    ...(command ? [`Команда: ${command}`] : []),
    ...flagFacts(argv),
    ...decodedParameterFacts(argv),
    // The exact argv stays visible so an approval can always be checked against what will run.
    `Точная команда: ${argv.join(" ")}`,
  ];
}
