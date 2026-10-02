import {
  PROMPT_COMMANDS,
  isPromptControlCommand,
  parsePromptCommand,
} from "./prompt-commands.js";
import { buildAgentHeader } from "./agent-header.js";
import { renderAttentionRows, renderBlockLines } from "./blocks.js";
import { copyTextToClipboard } from "./clipboard.js";
import {
  dismissTypeahead,
  inlineCommandHint,
  isTypeaheadOpen,
  moveTypeaheadSelection,
  renderCommandSuggestions,
  selectedTypeaheadCommand,
  typeaheadCompletion,
  typeaheadFor,
} from "./command-typeahead.js";
import {
  formatDevRebuildStatus,
  summarizeChangedFiles,
} from "./dev-rebuild-status.js";
import {
  formatStoredDiagnostic,
  presentDiagnostic,
} from "./diagnostic-presentation.js";
import { interruptedError } from "./errors.js";
import { FileContentCache } from "./file-content-cache.js";
import {
  EMPTY_LINE,
  PromptHistory,
  applyLineEditorKey,
  deleteForward,
  layoutPromptInput,
  lineOf,
  movePromptLine,
  visibleLine,
} from "./line-editor.js";
import { nextLogDisplayMode } from "./log-display-mode.js";
import { MessageQueue, renderMessageQueueRows } from "./message-queue.js";
import {
  initialModelEditorState,
  transitionModelEditor,
} from "./model-editor.js";
import { promptPlaceholder } from "./prompt-placeholder.js";
import {
  initialProviderPickerState,
  transitionProviderPicker,
} from "./provider-picker.js";
import { renderQuestionPanel } from "./question-panel.js";
import {
  enterBadge,
  renderAcknowledgeQuestion,
  renderFlowPanel,
  renderModelEditorQuestion,
  renderSelectQuestion,
  renderTextQuestion,
} from "./setup-panel.js";
import {
  formatAssistantResponseStats,
  formatTokenFlow,
  formatTurnDuration,
  isIncompleteOsc,
  isIncompletePaste,
  nextKey,
  sanitizePastedText,
  stripPasteStart,
  stripPromptControlCharacters,
  takeUntil,
  typewriterText,
} from "./stream-format.js";
import { TraceViewerSession } from "./traces/trace-viewer-session.js";
import { buildStatusLine } from "./status-line.js";
import { createTheme, detectUnicode } from "./theme.js";
import {
  isPanelRoutedTool,
  presentPreparingTool,
  presentTool,
  readWriteFileInput,
  toolBaseName,
} from "./tool-presentation.js";
import { groupToolBlocksForDisplay } from "./tool-block-groups.js";
import { TurnClock } from "./turn-clock.js";
import {
  allTodoItemsSettled,
  readTodoToolItems,
  renderFinishedTodoRows,
  renderTodoPanelRows,
} from "./todo-panel.js";
import {
  reduceSetupSelectInput,
  setupSelectionIntent,
} from "./setup-selection-input.js";
import {
  BACKGROUND_COLOR_QUERY,
  parseBackgroundColorReply,
} from "./terminal-background.js";
import { inspectError } from "#internal/logging.js";
import { eveVersionTag } from "#cli/banner.js";
import {
  clipVisible,
  renderInputText,
  renderInputWithBlockCursor,
  stripAnsi,
  stripTerminalControls,
} from "#cli/ui/terminal-text.js";
import { renderCursorRow } from "#setup/cli/option-row.js";
import {
  initialSelectState,
  reduceSelect,
  searchActionQuery,
  selectValueAtCursor,
} from "#setup/cli/select-state.js";
import { toErrorMessage } from "#shared/errors.js";
import { StringDecoder } from "node:string_decoder";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { parseDevRebuildLogLine } from "#internal/nitro/host/dev-watcher-log.js";
import { LiveRegion } from "#cli/ui/live-region.js";
import { AltScreen } from "#cli/ui/alt-screen.js";
import {
  PROGRESS_PULSE_ASCII_GLYPH,
  PROGRESS_PULSE_GLYPH,
  isProgressPulseVisible,
} from "#cli/ui/progress-pulse.js";
import { readGatewayServiceTier } from "#shared/gateway-service-tier.js";
function isMultiSelectRequest(e) {
  return e.kind === `multi` || e.kind === `searchable-multi`;
}
function moveActionCursor(e, t, n) {
  return n === 0
    ? void 0
    : e === void 0
      ? t === `down`
        ? 0
        : n - 1
      : (e + (t === `down` ? 1 : -1) + n) % n;
}
function completedTurnStatus(e) {
  return e.interrupted
    ? `Interrupted`
    : e.cancelled
      ? `Cancelled`
      : e.continueSession
        ? `Ready`
        : `Done`;
}
const incompletePasteFlushMs = 1e3,
  STATUS = {
    processing: `Working…`,
    connectionAuth: `Waiting for connection authorization…`,
  };
var TerminalRenderer = class {
  #e;
  #t;
  #n;
  #r;
  #i;
  #a;
  #o;
  #s;
  #c;
  #l;
  #u;
  #d;
  #f;
  #p;
  #m = [];
  #h = new Map();
  #g = new Set();
  #_ = [];
  #v = new Set();
  #y = new Map();
  #b = 0;
  #x = new Map();
  #S = new Set();
  #C = new Set();
  #w = new FileContentCache();
  #T = new Set();
  #E;
  #D = !1;
  #O;
  #k = [];
  #A;
  #j = 0;
  #M;
  #N;
  #P = ``;
  #F = 0;
  #I = new PromptHistory();
  #L = !1;
  #R;
  #z = !1;
  #B = Date.now();
  #V = !1;
  #H = new TurnClock();
  #U = EMPTY_LINE;
  #W = !1;
  #G = { kind: `idle` };
  #K;
  #q = STATUS.processing;
  #J;
  #Y = `eve`;
  #X = !1;
  #Z = !1;
  #Q = !1;
  #$ = !1;
  #ee = !1;
  #te = !1;
  #ne;
  #re = !0;
  #ie = 0;
  #ae = Date.now();
  #oe;
  #se;
  #ce;
  #le = !1;
  #ue;
  #de = ``;
  #fe = new StringDecoder(`utf8`);
  #pe;
  #me;
  #he;
  #ge = !1;
  #_e = !1;
  #ve;
  #ye;
  #be;
  #xe;
  #Se;
  #Ce;
  #we;
  #Te = ``;
  #Ee = ``;
  #De;
  #Oe;
  #ke = 0;
  #Ae;
  #je;
  #Me;
  #Ne;
  #Pe;
  #Fe;
  #Ie = new MessageQueue();
  #Le;
  #Re = !1;
  #ze;
  #Be;
  #Ve = !1;
  #He;
  #Ue;
  #We;
  #Ge;
  #Ke;
  setupFlow = {
    begin: (e, t) => this.#Qe(e, t),
    end: (e) => this.#$e(e?.preserveDiagnostics ?? !0),
    readSelect: (e) => this.#et(e),
    readEditableSelect: (e) => this.#nt(e),
    readProviderPicker: (e) => this.#rt(e),
    readModelEditor: (e) => this.#it(e),
    readText: (e) => this.#at(e),
    readAcknowledge: (e) => this.#ot(e),
    readChoice: (e) => this.#tt(e),
    setStatus: (e) => this.#mt(e),
    renderLine: (e, t) => this.#ht(e, t),
    replaceContent: (e) => this.#gt(e),
    renderOutput: (e) => this.#_t(e),
    withInheritedStdio: (e) => this.#vt(e),
    withExclusiveTerminal: (e) => this.#vt(e),
    waitForInterrupt: (e) => this.#dt(e),
  };
  traceViewer = { open: (e) => this.#bt(e) };
  constructor(t) {
    ((this.#e = t?.input ?? process.stdin),
      (this.#t = t?.output ?? process.stdout),
      (this.#n = new LiveRegion(this.#t)),
      (this.#r = new AltScreen(this.#t)),
      (this.#i = createTheme({
        color: t?.color ?? !0,
        unicode: t?.unicode ?? detectUnicode(),
      })),
      (this.#a = t?.tools ?? `auto-collapsed`),
      (this.#o = t?.reasoning ?? `auto-collapsed`),
      (this.#s = t?.subagents ?? `auto-collapsed`),
      (this.#c = t?.connectionAuth ?? `full`),
      (this.#l = t?.assistantResponseStats ?? `tokensPerSecond`),
      (this.#be = t?.contextSize),
      (this.#u = t?.captureForeignOutput ?? this.#t === process.stdout),
      (this.#d = t?.diagnostics),
      (this.#ne = t?.onExitRequest),
      (this.#p = t?.logs ?? `none`),
      (this.#f = t?.availablePromptCommands ?? PROMPT_COMMANDS));
  }
  renderAgentHeader(e) {
    ((this.#Y = e.name), (this.#E = e), this.#Ct());
    let t = this.#pn().join(`
`);
    if (this.#D) {
      (t !== this.#O &&
        ((this.#O = t), this.#Bt({ kind: `agent-header`, body: t, live: !1 })),
        this.#cn());
      return;
    }
    ((this.#D = !0), (this.#O = t), this.#n.flush(this.#pn(), []));
  }
  async readPrompt(e) {
    (this.#Ct(e),
      this.#zt(),
      this.#Ht(),
      (this.#L = !0),
      (this.#z = !0),
      (this.#G = { kind: `idle` }),
      (this.#q = ``),
      (this.#te = !1));
    let r = this.#Ie
        .restoreDraft()
        ?.split(
          `
`,
        )
        .map(stripPromptControlCharacters).join(`
`),
      i = stripPromptControlCharacters(e?.initialDraft ?? this.#U.text),
      a = lineOf(r === void 0 ? i : i.length === 0 ? r : `${r}\n\n${i}`);
    return (
      (this.#U = EMPTY_LINE),
      this.#I.begin(a.text),
      this.#qe(a),
      (this.#R = typeaheadFor(this.#f, a.text)),
      this.#Pt(),
      this.#cn(),
      await new Promise((e, r) => {
        this.#K = r;
        let apply = (e) => {
            ((a = e),
              this.#It(),
              this.#qe(a),
              (this.#R = typeaheadFor(this.#f, e.text, this.#R)),
              this.#cn());
          },
          recall = (e) => {
            e !== void 0 && apply(lineOf(e));
          },
          interrupt = () => {
            ((this.#R = void 0), this.#Ft(), this.#Tt(), r(interruptedError()));
          },
          suggestions = () =>
            this.#R !== void 0 && isTypeaheadOpen(this.#R) ? this.#R : void 0,
          highlighted = () => {
            let e = suggestions();
            return e === void 0 ? void 0 : selectedTypeaheadCommand(e);
          };
        ((this.#ue = (r) => {
          r.type !== `ctrl-c` && this.#te && ((this.#te = !1), this.#cn());
          let i = applyLineEditorKey(a, r, { multiline: !0 });
          if (i !== void 0) {
            apply(i);
            return;
          }
          switch (r.type) {
            case `up`:
            case `ctrl-p`: {
              let e = suggestions();
              if (e !== void 0) {
                ((this.#R = moveTypeaheadSelection(e, -1)), this.#cn());
                break;
              }
              let t = movePromptLine(a, `up`);
              t === void 0 ? recall(this.#I.previous(a.text)) : apply(t);
              break;
            }
            case `down`:
            case `ctrl-n`: {
              let e = suggestions();
              if (e !== void 0) {
                ((this.#R = moveTypeaheadSelection(e, 1)), this.#cn());
                break;
              }
              let t = movePromptLine(a, `down`);
              t === void 0 ? recall(this.#I.next()) : apply(t);
              break;
            }
            case `tab`: {
              let e = highlighted();
              e !== void 0 && apply(lineOf(typeaheadCompletion(e)));
              break;
            }
            case `escape`: {
              let e = suggestions();
              e !== void 0 && ((this.#R = dismissTypeahead(e)), this.#cn());
              break;
            }
            case `enter`: {
              let r = highlighted(),
                i =
                  r !== void 0 && parsePromptCommand(a.text) === null
                    ? typeaheadCompletion(r).trimEnd()
                    : a.text;
              if (i.trim().length === 0) break;
              ((this.#R = void 0),
                this.#I.add(i),
                (this.#L = !1),
                this.#Ft(),
                (this.#q = STATUS.processing),
                isPromptControlCommand(i)
                  ? this.#Bt({
                      kind: `command`,
                      body: stripTerminalControls(i.trim()),
                      live: !1,
                    })
                  : (this.#Rt(), this.#Vt(i), (this.#Ae = i), this.#H.arm()),
                this.#qe(EMPTY_LINE),
                this.#cn(),
                this.#Dt(),
                e(i));
              break;
            }
            case `ctrl-d`:
              a.text.length === 0
                ? (this.#yt(), interrupt())
                : apply(deleteForward(a));
              break;
            case `ctrl-l`:
              this.#dn();
              break;
            case `ctrl-r`:
              this.#cn();
              break;
            case `ctrl-c`:
              if (this.#te) {
                (this.#yt(), interrupt());
                break;
              }
              ((this.#te = !0), apply(EMPTY_LINE));
              break;
            default:
              break;
          }
        }),
          this.#Et());
      })
    );
  }
  #qe(e) {
    ((this.#P = e.text), (this.#F = e.cursor));
  }
  takeQueuedPrompt() {
    let e = this.#Ie.view().steering,
      t = this.#Ie.takePrompt();
    return (t !== void 0 && (this.#Be = e ? `steer` : `queue`), t);
  }
  async renderStream(e, t) {
    (this.#Ct(t),
      this.#g.clear(),
      (this.#L = !1),
      this.#G.kind !== `waiting` &&
        (this.#G = { kind: `waiting`, startedAtMs: Date.now() }),
      (this.#q = this.#j > 0 ? STATUS.connectionAuth : STATUS.processing),
      this.#Ut(t?.submittedPrompt),
      t?.submittedPrompt !== void 0 && this.#d?.recordPrompt(),
      t?.submittedPrompt !== void 0 && !this.#H.armed && this.#H.arm(),
      (this.#$ = !1),
      (this.#Re = !1),
      (this.#Ve = !1),
      (this.#He = t?.submittedPrompt),
      this.#Ie.beginTurn(),
      (this.#Le = e.cancel),
      (this.#ve = void 0),
      (this.#ye = void 0),
      (this.#xe = void 0),
      (this.#Se = void 0),
      (this.#Ce = Date.now()));
    let n = {
      tools: t?.tools ?? this.#a,
      reasoning: t?.reasoning ?? this.#o,
      assistantResponseStats: t?.assistantResponseStats ?? this.#l,
    };
    (this.#Lt(), (this.#W = !0), this.#cn());
    let r = new Promise((e) => {
      this.#he = e;
    });
    ((this.#ue = (e) => this.#Nt(e)), this.#Et());
    let i = {
      text: new Map(),
      reasoning: new Map(),
      tools: new Map(),
      cancelled: !1,
      restoreCancelledPrompt: !0,
    };
    try {
      for await (let t of takeUntil(iterateTUIStream(e.events), r)) {
        if (this.#$) break;
        this.#Xt(t, n, i);
      }
    } catch (e) {
      let t = summarizeKnownError(e);
      t === null
        ? this.#Wt(`Error`, toErrorMessage(e), { detail: inspectError(e) })
        : this.#Wt(t.name, t.message, {
            detail: inspectError(e),
            hint: t.hint,
          });
    } finally {
      ((this.#he = void 0),
        this.#$ && e.abort?.(),
        (this.#Le = void 0),
        this.#Dt(),
        this.#zt(),
        (this.#W = !1),
        this.#G.kind === `waiting` && (this.#G = { kind: `idle` }),
        (this.#q = completedTurnStatus({
          interrupted: this.#$,
          cancelled: this.#Re,
          continueSession: t?.continueSession === !0,
        })),
        this.#rn(i),
        (this.#$ || i.cancelled) && this.#nn(i),
        this.#Yt(),
        this.#d?.reportStats(),
        this.#cn(),
        t?.continueSession || this.#Tt());
    }
  }
  async renderIdleStream(e, t) {
    let n = {
        tools: t?.tools ?? this.#a,
        reasoning: t?.reasoning ?? this.#o,
        assistantResponseStats: t?.assistantResponseStats ?? this.#l,
      },
      r = {
        text: new Map(),
        reasoning: new Map(),
        tools: new Map(),
        cancelled: !1,
        restoreCancelledPrompt: !1,
      };
    try {
      for await (let t of iterateTUIStream(e.events)) this.#Xt(t, n, r);
    } catch (e) {
      let t = summarizeKnownError(e);
      t === null
        ? this.#Wt(`Error`, toErrorMessage(e), { detail: inspectError(e) })
        : this.#Wt(t.name, t.message, {
            detail: inspectError(e),
            hint: t.hint,
          });
    } finally {
      (this.#rn(r),
        r.cancelled && this.#nn(r),
        this.#Yt(),
        this.#d?.reportStats(),
        this.#cn());
    }
  }
  async readToolApproval(e, t) {
    return (
      this.#Ct(t),
      this.#zt(),
      (this.#L = !1),
      (this.#G = { kind: `idle` }),
      (this.#q = `Approve ${formatToolApprovalTitle(e)}?  (y/n)`),
      (this.#$ = !1),
      this.#cn(),
      await new Promise((t, n) => {
        ((this.#K = n),
          (this.#ue = (r) => {
            switch (r.type) {
              case `text`: {
                if (r.framing !== `unframed`) break;
                let n = r.value.toLowerCase();
                n === `y`
                  ? (this.#Rt(),
                    (this.#q = STATUS.processing),
                    this.#Dt(),
                    this.#cn(),
                    t({ approved: !0 }))
                  : n === `n` &&
                    (this.#Rt(),
                    (this.#q = STATUS.processing),
                    this.#Ye(e.toolCallId),
                    this.#Dt(),
                    this.#cn(),
                    t({ approved: !1, reason: `Denied by user.` }));
                break;
              }
              case `ctrl-r`:
                this.#cn();
                break;
              case `ctrl-c`:
                ((this.#$ = !0), this.#Tt(), n(interruptedError()));
                break;
              default:
                break;
            }
          }),
          this.#Et());
      })
    );
  }
  async readInputQuestion(e, t) {
    (this.#Ct(t),
      this.#zt(),
      (this.#L = !1),
      (this.#z = !1),
      (this.#G = { kind: `idle` }),
      (this.#$ = !1));
    let n = e.options ?? [],
      r = n.length > 0,
      i = (e.allowFreeform === !0 || !r) && r,
      a = n.length + +!!i,
      o = questionSectionId(e.requestId),
      s = r ? `overlay` : `text`,
      c = 0,
      l = EMPTY_LINE,
      isOnFreeformRow = () => i && c === n.length,
      overlayPanel = (t) =>
        renderQuestionPanel(
          {
            prompt: stripTerminalControls(e.prompt),
            options: n,
            cursor: c,
            allowFreeform: i,
            editor: l,
            caretVisible: this.#re,
          },
          this.#i,
          t,
        ),
      renderTextSection = () => {
        this.#Kt({
          id: o,
          kind: `question`,
          title: stripTerminalControls(e.prompt),
          body: formatQuestionContent(e, void 0, this.#i),
          preformatted: !0,
          live: !0,
        });
      },
      syncFreeformCaret = () => {
        isOnFreeformRow() ? this.#Pt() : (this.#Ft(), this.#It());
      };
    s === `overlay`
      ? ((s = `overlay`),
        (this.#L = !1),
        this.#Jt(o),
        (this.#je = overlayPanel),
        (this.#q = ``),
        syncFreeformCaret(),
        this.#cn())
      : ((s = `text`),
        (this.#je = void 0),
        renderTextSection(),
        (this.#L = !0),
        this.#qe(l),
        (this.#q = ``),
        this.#Pt(),
        this.#cn());
    let finalize = (t) => {
        ((this.#je = void 0),
          this.#Kt({
            id: o,
            kind: `question`,
            title: stripTerminalControls(e.prompt),
            body: `${this.#i.colors.dim(this.#i.glyph.elbow)}  ${stripTerminalControls(t.label)}`,
            preformatted: !0,
            live: !1,
          }),
          (this.#L = !1),
          this.#Rt(),
          (this.#q = STATUS.processing),
          this.#Ft(),
          this.#Dt(),
          this.#cn());
        let n = {};
        return (
          t.optionId !== void 0 && (n.optionId = t.optionId),
          t.text !== void 0 && (n.text = t.text),
          n
        );
      },
      dismiss = () => {
        ((this.#je = void 0),
          this.#Kt({
            id: o,
            kind: `question`,
            title: stripTerminalControls(e.prompt),
            body: `${this.#i.colors.dim(this.#i.glyph.elbow)}  ${this.#i.colors.dim(`Dismissed.`)}`,
            preformatted: !0,
            live: !1,
          }),
          (this.#L = !1),
          (this.#q = ``),
          this.#Ft(),
          this.#Dt(),
          this.#cn(),
          u(void 0));
      },
      moveCursor = (e) => {
        a !== 0 && ((c = (c + e + a) % a), syncFreeformCaret(), this.#cn());
      },
      selectOptionAt = (e) => {
        let t = n[e];
        t && u(finalize({ optionId: t.id, label: t.label }));
      },
      u;
    return await new Promise((t, r) => {
      ((this.#K = r),
        (u = t),
        (this.#ue = (t) => {
          if (t.type === `ctrl-c`) {
            if ((s === `text` || isOnFreeformRow()) && l.text.length > 0) {
              ((l = EMPTY_LINE),
                this.#It(),
                s === `text` && this.#qe(l),
                this.#cn());
              return;
            }
            ((this.#$ = !0),
              (this.#je = void 0),
              this.#Ft(),
              this.#Tt(),
              r(interruptedError()));
            return;
          }
          if (t.type === `ctrl-r`) {
            this.#cn();
            return;
          }
          if (s === `overlay`) {
            switch (t.type) {
              case `up`:
              case `ctrl-p`:
                moveCursor(-1);
                break;
              case `down`:
              case `ctrl-n`:
                moveCursor(1);
                break;
              case `enter`:
                if (isOnFreeformRow()) {
                  let t = resolveQuestionText(l.text, e);
                  t !== void 0 && u(finalize(t));
                  break;
                }
                selectOptionAt(c);
                break;
              case `escape`:
                if (isOnFreeformRow() && l.text.length > 0) {
                  ((l = EMPTY_LINE), this.#It(), this.#cn());
                  break;
                }
                dismiss();
                break;
              default:
                if (isOnFreeformRow()) {
                  let e = applyLineEditorKey(l, t);
                  e !== void 0 && ((l = e), this.#It(), this.#cn());
                  break;
                }
                if (t.type === `text` && /^[1-9]$/u.test(t.value)) {
                  let e = Number(t.value) - 1;
                  e < n.length
                    ? selectOptionAt(e)
                    : e === n.length &&
                      i &&
                      ((c = e), syncFreeformCaret(), this.#cn());
                }
                break;
            }
            return;
          }
          let a = applyLineEditorKey(l, t, { multiline: !0 });
          if (a !== void 0) {
            ((l = a), this.#It(), this.#qe(l), this.#cn());
            return;
          }
          switch (t.type) {
            case `up`:
            case `down`: {
              let e = movePromptLine(l, t.type);
              e !== void 0 && ((l = e), this.#It(), this.#qe(l), this.#cn());
              break;
            }
            case `enter`: {
              let t = resolveQuestionText(l.text, e);
              if (t === void 0) break;
              u(finalize(t));
              break;
            }
            case `escape`:
              if (l.text.length > 0) {
                ((l = EMPTY_LINE), this.#It(), this.#qe(l), this.#cn());
                break;
              }
              dismiss();
              break;
            default:
              break;
          }
        }),
        this.#Et());
    });
  }
  upsertSubagentStep(e) {
    if ((this.#d?.recordSubagentDispatch(e.callId), this.#s === `hidden`))
      return;
    let t = stripTerminalControls(e.reasoning ?? ``).trim(),
      n = stripTerminalControls(e.message ?? ``).trim();
    if (!(t.length === 0 && n.length === 0)) {
      if ((this.#Gt(e.callId, e.subagentName), this.#s === `collapsed`)) {
        this.#cn();
        return;
      }
      (this.#qt({
        id: subagentStepSectionId(e.callId, e.sectionKey),
        kind: `subagent-step`,
        subagentCallId: e.callId,
        depth: 1,
        reasoning: t,
        body: n,
        collapsed: this.#s !== `full`,
        live: !e.finalized,
      }),
        this.#cn());
    }
  }
  upsertSubagentTool(e) {
    if (
      (this.#d?.recordSubagentDispatch(e.callId),
      e.status === `failed` &&
        e.errorText !== void 0 &&
        this.#d?.append({
          source: `tool`,
          summary: `${e.toolName} failed (subagent ${e.subagentName})`,
          detail: e.errorText,
        }),
      this.#s === `hidden`)
    )
      return;
    if ((this.#Gt(e.callId, e.subagentName), this.#s === `collapsed`)) {
      this.#cn();
      return;
    }
    let t = subagentToolStatus(e.status),
      n =
        e.status === `preparing`
          ? presentPreparingTool(e.toolName)
          : presentTool(
              e.toolName,
              e.input,
              this.#en({
                input: e.input,
                output: e.output,
                toolCallId: e.childCallId,
                toolName: e.toolName,
              }),
            ),
      r = {
        id: subagentToolSectionId(e.callId, e.childCallId),
        kind: `subagent-tool`,
        subagentCallId: e.callId,
        depth: 1,
        title: stripTerminalControls(n.title),
        subtitle: stripTerminalControls(n.subtitle),
        status: t,
        live: t === `running` || t === `approval`,
        expanded: this.#s === `full`,
        toolName: e.toolName,
        toolGroup: n.group,
        toolInput: e.input,
      };
    (n.doneTitle !== void 0 &&
      (r.doneTitle = stripTerminalControls(n.doneTitle)),
      n.detail !== void 0 &&
        ((r.detailLines = n.detail),
        (r.keepDetailWhenDone = n.keepDetailWhenDone === !0)),
      e.output === void 0
        ? e.errorText !== void 0 &&
          (r.result = stripTerminalControls(e.errorText))
        : ((r.result = n.summarizeResult(e.output)), (r.toolOutput = e.output)),
      this.#qt(r),
      this.#Je(e.callId),
      this.#cn());
  }
  #Je(e) {
    applyCohortLiveness(
      this.#m
        .filter((t) => t.kind === `subagent-tool` && t.subagentCallId === e)
        .map((e) => ({ block: e, active: isActiveToolStatus(e.status) })),
    );
  }
  removeSubagentTool(e) {
    (this.#Jt(subagentToolSectionId(e.callId, e.childCallId)), this.#cn());
  }
  subagents = {
    begin: (e) => this.beginSubagent(e),
    background: (e) => this.backgroundSubagent(e),
    upsertStep: (e) => this.upsertSubagentStep(e),
    upsertTool: (e) => this.upsertSubagentTool(e),
    removeTool: (e) => this.removeSubagentTool(e),
    complete: (e) => this.completeSubagent(e),
    markChildToolCallId: (e) => this.markChildToolCallId(e),
  };
  beginSubagent(e) {
    if (this.#s === `hidden`) return;
    this.#Gt(e.callId, e.name);
    let t = this.#h.get(subagentHeaderId(e.callId));
    (t !== void 0 && (t.status === `done` && delete t.status, (t.live = !0)),
      this.#C.delete(e.callId),
      this.#cn());
  }
  backgroundSubagent(e) {
    let t = this.#h.get(subagentHeaderId(e.callId));
    t === void 0 ||
      this.#g.has(subagentHeaderId(e.callId)) ||
      ((t.status = `running`),
      (t.live = !0),
      (t.updateSeq = ++this.#b),
      this.#S.add(e.callId),
      this.#cn());
  }
  completeSubagent(e) {
    let t = this.#h.get(subagentHeaderId(e.callId));
    if (t !== void 0) {
      if (((t.status = `done`), e.authoritative)) {
        (this.#S.delete(e.callId), this.#C.delete(e.callId));
        for (let t of this.#m) t.subagentCallId === e.callId && (t.live = !1);
      } else {
        this.#C.add(e.callId);
        for (let t of this.#m) t.subagentCallId === e.callId && (t.live = !0);
      }
      this.#cn();
    }
  }
  markChildToolCallId(e) {
    this.#v.add(e);
    let t = this.#y.get(e);
    t !== void 0 && (this.#Jt(t), this.#y.delete(e), this.#cn());
  }
  #Ye(e) {
    let t = this.#h.get(toolSectionId(e));
    t !== void 0 && ((t.status = `denied`), (t.live = !1));
  }
  upsertConnectionAuth(e) {
    if (this.#c === `hidden`) return;
    let t = connectionAuthTerminalMessage(e.state);
    (this.#Kt({
      id: connectionAuthSectionId(e.name),
      kind: `connection-auth`,
      title: `${stripTerminalControls(e.name)} · authorization · ${e.state}`,
      body: formatConnectionAuthContent(e, t),
      preformatted: !0,
      live: t === void 0,
    }),
      this.#cn());
  }
  setConnectionAuthPendingCount(e) {
    let t = Math.max(0, e);
    if (t === this.#j) return;
    let n = this.#j > 0;
    ((this.#j = t),
      t > 0
        ? ((this.#q = STATUS.connectionAuth), this.#cn())
        : n && ((this.#q = STATUS.processing), this.#cn()));
  }
  setVercelStatus(e) {
    ((this.#M = e), this.#cn());
  }
  setRemoteConnectionStatus(e) {
    ((this.#N = e), this.#cn());
  }
  reset() {
    ((this.#m = []),
      this.#h.clear(),
      this.#g.clear(),
      (this.#A = void 0),
      (this.#k.length = 0),
      (this.#_.length = 0),
      (this.#D = !1),
      (this.#O = void 0),
      this.#Xe(),
      (this.#V = !1),
      (this.#Ae = void 0),
      (this.#Oe = void 0),
      (this.#j = 0),
      (this.#ve = void 0),
      (this.#ye = void 0),
      (this.#xe = void 0),
      (this.#Se = void 0),
      (this.#Ce = void 0),
      this.#X && (this.#n.clearAll(), this.#cn()));
  }
  renderSessionBoundary() {
    (this.#Ht(), this.#Xe());
    let e = this.#i.colors,
      t = this.#i.glyph,
      n = e.dim(
        `${t.cornerOpen}${t.dash.repeat(2)} Session restarted, clear context.`,
      );
    (this.#Bt({ kind: `session-boundary`, body: n, live: !1 }), this.#cn());
  }
  #Xe() {
    (this.#v.clear(),
      this.#y.clear(),
      this.#T.clear(),
      this.#S.clear(),
      this.#C.clear(),
      this.#x.clear(),
      (this.#Pe = void 0),
      (this.#Fe = void 0),
      this.#Ie.reset(),
      (this.#Be = void 0),
      this.#w.clear(),
      this.#H.reset());
  }
  renderNotice(e) {
    let t = stripTerminalControls(e);
    t.trim().length !== 0 &&
      (this.#Ct(), this.#Bt({ kind: `notice`, body: t, live: !1 }), this.#cn());
  }
  renderSandboxLog(e) {
    let t = parseSandboxLogLine(stripTerminalControls(e));
    t !== void 0 &&
      (this.#d?.append({ source: `sandbox`, detail: t }),
      this.#Ct(),
      this.#Bt({ kind: `sandbox`, body: t, live: !1 }),
      this.#cn());
  }
  renderSetupWarning(e) {
    let t = stripTerminalControls(e);
    if (t.trim().length === 0) {
      this.#Ze();
      return;
    }
    (this.#Ct(), (this.#Ne = t), this.#cn());
  }
  clearSetupWarning() {
    this.#Ze();
  }
  #Ze() {
    this.#Ne !== void 0 && ((this.#Ne = void 0), this.#cn());
  }
  renderCommandInvocation(e, t) {
    let n = stripTerminalControls(e);
    if (n.trim().length === 0) return;
    this.#Ct();
    let r = { kind: `command`, body: n, live: !1 };
    (t === `failed` && (r.status = `error`), this.#Bt(r), this.#cn());
  }
  renderCommandResult(e, t) {
    let n = stripAnsi(e);
    n.trim().length !== 0 &&
      (this.#Ct(),
      this.#Bt(
        t === `success`
          ? { kind: `result`, body: n, live: !1, status: `done` }
          : t === `error`
            ? { kind: `flow`, title: t, body: n, live: !1 }
            : { kind: `result`, body: n, live: !1 },
      ),
      this.#cn());
  }
  #Qe(e, t = `spinner`) {
    (this.#Ct(), (this.#L = !1), (this.#G = { kind: `idle` }), (this.#q = ``));
    let n =
      t === `pulse`
        ? { kind: `pulse`, startedAtMs: Date.now() }
        : { kind: `spinner` };
    ((this.#Me = {
      title: stripTerminalControls(e),
      indicator: n,
      lines: [],
      outputBuffer: [],
    }),
      this.#Lt(),
      this.#cn());
  }
  #$e(e) {
    ((this.#Ue = void 0), this.#pt());
    let t = this.#Me;
    if (t !== void 0) {
      if (((this.#Me = void 0), this.#zt(), e)) {
        let e = [];
        for (let n of t.lines) {
          if (n.evidence === !0) {
            e.push(n.text);
            continue;
          }
          ((n.tone === `warning` || n.tone === `error`) &&
            (e.length > 0 &&
              this.#Bt({
                kind: `flow`,
                title: `info`,
                body: e.join(`
`),
                live: !1,
              }),
            this.#Bt({ kind: `flow`, title: n.tone, body: n.text, live: !1 })),
            (e = []));
        }
      }
      this.#cn();
    }
  }
  async #et(e) {
    let t = this.#st(),
      n = isMultiSelectRequest(e),
      r = e.kind === `search` ? e.searchAction : void 0,
      i = e.options,
      a = { options: i, searchAction: r, submitRow: n };
    (`initialValue` in e &&
      e.initialValue !== void 0 &&
      (a.defaultValue = e.initialValue),
      `initialValues` in e &&
        e.initialValues !== void 0 &&
        (a.initialValues = e.initialValues));
    let o = initialSelectState(a),
      s,
      c = !1,
      l = 0,
      isCurrentSearch = (e) => e === l,
      clearSearch = () => {
        ((l += 1),
          (c = !1),
          (o = reduceSelect(
            o,
            { type: `clear` },
            { options: i, searchAction: r, submitRow: n },
          )),
          this.#cn());
      },
      loadSearch = async (e, t) => {
        ((c = !0), (s = void 0));
        let a = ++l;
        this.#cn();
        try {
          let s = await t(e);
          if (!isCurrentSearch(a)) return;
          let c = o.filter;
          ((i = s),
            (o = {
              ...initialSelectState({
                options: s,
                searchAction: r,
                submitRow: n,
              }),
              filter: c,
            }));
        } catch (e) {
          isCurrentSearch(a) && (s = toErrorMessage(e));
        } finally {
          isCurrentSearch(a) && ((c = !1), this.#cn());
        }
      },
      u = e.notices;
    if (
      e.kind === `task-list` ||
      (e.kind === `search` && e.layout === `task-list`)
    ) {
      let n = t.taskListLineStart ?? t.lines.length,
        r = t.lines
          .slice(n)
          .filter(
            (e) =>
              e.tone === `success` ||
              e.tone === `warning` ||
              e.tone === `error`,
          )
          .map((e) => ({ tone: e.tone, text: e.text }));
      ((u = e.notices ?? r),
        (t.taskListLineStart = t.lines.length),
        (t.hideLinesWhileQuestion = !0));
    }
    let panelState = () => {
      let t = { ...e, options: i, select: o };
      return (
        u !== void 0 && u.length > 0 && (t.notices = u),
        s !== void 0 && (t.error = s),
        c && (t.loadingFrame = this.#hn()),
        t
      );
    };
    return (
      (t.question = (e) => renderSelectQuestion(panelState(), this.#i, e)),
      this.#cn(),
      await this.#ut((t, a) => {
        let close = (e) => {
          ((l += 1), a(e));
        };
        if (c) {
          t.type === `ctrl-c`
            ? close(void 0)
            : t.type === `escape`
              ? clearSearch()
              : t.type === `ctrl-r` && this.#cn();
          return;
        }
        let u = { key: t, options: i, searchAction: r, select: o },
          d = reduceSetupSelectInput(
            n
              ? { ...u, kind: e.kind, required: e.required }
              : { ...u, kind: e.kind },
          );
        switch (d.kind) {
          case `cancel`:
            close(void 0);
            return;
          case `repaint`:
            this.#cn();
            return;
          case `update`:
            ((o = d.select), (s = void 0), this.#cn());
            return;
          case `submit`: {
            let e = searchActionQuery(d.values[0] ?? ``),
              t = r?.load;
            if (e === void 0 || t === void 0) {
              close(d.values);
              return;
            }
            loadSearch(e, t);
            return;
          }
          case `error`:
            ((s = d.message), this.#cn());
            return;
          case `ignore`:
            return;
        }
      }).promise
    );
  }
  #tt(e) {
    this.#Ct();
    let t = this.#ct();
    t.status = {
      kind: `progress`,
      text: stripTerminalControls(e.status),
      startedAtMs: Date.now(),
    };
    let n;
    ((t.question = (t) =>
      renderSelectQuestion(
        { kind: `actions`, context: e.context, actions: e.actions, cursor: n },
        this.#i,
        t,
      )),
      this.#cn());
    let r = this.#ut(
      (t, r) => {
        let i = setupSelectionIntent(t);
        switch (i?.kind) {
          case `cancel`:
            r(void 0);
            return;
          case `move`:
            ((n = moveActionCursor(n, i.direction, e.actions.length)),
              this.#cn());
            return;
          case `repaint`:
            this.#cn();
            return;
          case `submit`:
            n !== void 0 && r(e.actions[n].value);
            return;
          case void 0:
            return;
        }
      },
      () => {
        t.status = void 0;
      },
    );
    return { choice: r.promise, close: () => r.settle(void 0) };
  }
  async #nt(e) {
    let t = this.#st(),
      n = { options: e.options };
    e.initialValue !== void 0 && (n.defaultValue = e.initialValue);
    let r = initialSelectState(n),
      i = lineOf(``),
      a;
    t.question = (t) => {
      let n = {
        kind: `inline-edit`,
        layout: `task-list`,
        message: e.message,
        options: e.options,
        select: r,
        edit: {
          optionValue: e.editable.value,
          caretVisible: this.#re,
          editor: {
            kind: `rename`,
            editor: i,
            defaultValue: e.editable.defaultValue,
            formatHint: e.editable.formatHint,
          },
        },
      };
      return (
        a !== void 0 && (n.error = a),
        renderSelectQuestion(n, this.#i, t)
      );
    };
    let onEditableRow = () =>
        selectValueAtCursor([...e.options], r.cursor) === e.editable.value,
      syncEditableRow = () => {
        onEditableRow() ? this.#Pt() : ((i = lineOf(``)), this.#Ft());
      };
    return (
      syncEditableRow(),
      this.#cn(),
      await this.#ut(
        (t, n) => {
          let applyEditor = (e) => {
              ((i = e), (a = void 0), this.#It(), this.#cn());
            },
            applySelect = (t) => {
              ((r = reduceSelect(r, t, { options: e.options })),
                (a = void 0),
                syncEditableRow(),
                this.#cn());
            },
            submit = () => {
              let t = selectValueAtCursor([...e.options], r.cursor);
              if (t === void 0) return;
              if (t !== e.editable.value) {
                n({ kind: `selected`, value: t });
                return;
              }
              let o = (i.text || e.editable.defaultValue).trim(),
                s = e.editable.validate?.(o);
              if (s !== void 0) {
                ((a = s), this.#cn());
                return;
              }
              n(
                o === e.editable.defaultValue
                  ? { kind: `selected`, value: t }
                  : { kind: `edited`, value: t, text: o },
              );
            },
            o = setupSelectionIntent(t);
          switch (o?.kind) {
            case `cancel`:
              n(void 0);
              return;
            case `move`:
              applySelect({ type: o.direction });
              return;
            case `submit`:
              submit();
              return;
            case `repaint`:
              this.#cn();
              return;
            case void 0:
              break;
          }
          if (!onEditableRow()) return;
          let s = applyLineEditorKey(i, t);
          s !== void 0 && applyEditor(s);
        },
        () => this.#Ft(),
      ).promise
    );
  }
  async #rt(e) {
    let t = this.#st(),
      n = initialProviderPickerState(e.options, e.initialValue),
      r,
      cursorBadge = () => {
        if (n.phase.kind !== `inactive`) return;
        let t = selectValueAtCursor([...e.options], n.select.cursor),
          r = e.options.find((e) => e.value === t);
        if (r !== void 0)
          return enterBadge(this.#i, r.checked === !0 ? `change` : void 0);
      };
    t.question = (t) => {
      let r = cursorBadge(),
        i = {
          kind: `inline-edit`,
          layout: `stacked`,
          message: e.message,
          options: e.options,
          select: n.select,
          edit: {
            optionValue: `ai-gateway-key`,
            caretVisible: this.#re,
            editor: { kind: `key`, phase: n.phase },
          },
        };
      return (
        r !== void 0 && (i.cursorBadge = r),
        renderSelectQuestion(i, this.#i, t)
      );
    };
    let syncCaret = () => {
      n.phase.kind === `editing` || n.phase.kind === `invalid`
        ? this.#Pt()
        : this.#Ft();
    };
    return (
      syncCaret(),
      this.#cn(),
      await this.#ut(
        (t, i, a) => {
          let dispatch = (t) => {
              let o = transitionProviderPicker(n, t, e.options);
              switch (o.kind) {
                case `ignore`:
                  return;
                case `clear`:
                  (r?.abort(),
                    (r = void 0),
                    (n = o.state),
                    syncCaret(),
                    this.#cn());
                  return;
                case `cancel`:
                  i(void 0);
                  return;
                case `render`:
                  ((n = o.state), syncCaret(), this.#cn());
                  return;
                case `validate`: {
                  ((n = o.state), syncCaret(), this.#cn());
                  let t = new AbortController();
                  r = t;
                  let i;
                  try {
                    i = e.validateInlineKey(o.key, t.signal);
                  } catch (e) {
                    a(e);
                    return;
                  }
                  i.then(
                    (e) => {
                      r !== t ||
                        t.signal.aborted ||
                        ((r = void 0),
                        dispatch({ type: `validated`, validation: e }));
                    },
                    (e) => {
                      r !== t || t.signal.aborted || ((r = void 0), a(e));
                    },
                  );
                  return;
                }
                case `settle`:
                  i(o.result);
                  return;
              }
            },
            o = setupSelectionIntent(t);
          switch (o?.kind) {
            case `cancel`:
              dispatch({ type: `cancel` });
              return;
            case `move`:
              dispatch({ type: `move`, direction: o.direction });
              return;
            case `submit`:
              dispatch({ type: `submit` });
              return;
            case `repaint`:
              this.#cn();
              return;
            case void 0:
              break;
          }
          if (n.phase.kind !== `editing` && n.phase.kind !== `invalid`) return;
          let s = applyLineEditorKey(n.phase.editor, t);
          s !== void 0 && (this.#It(), dispatch({ type: `edit`, editor: s }));
        },
        () => {
          (r?.abort(), (r = void 0), this.#Ft());
        },
      ).promise
    );
  }
  async #it(e) {
    let t = this.#st(),
      n = initialModelEditorState(e);
    return (
      (t.question = (t) =>
        renderModelEditorQuestion({ request: e, state: n }, this.#i, t)),
      this.#cn(),
      await this.#ut((t, r) => {
        let dispatch = (t) => {
            let i = transitionModelEditor(n, t, e);
            switch (i.kind) {
              case `ignore`:
                return;
              case `render`:
                ((n = i.state), this.#cn());
                return;
              case `cancel`:
                r(void 0);
                return;
              case `settle`:
                r(i.result);
                return;
            }
          },
          i = setupSelectionIntent(t);
        switch (i?.kind) {
          case `cancel`:
            dispatch({ type: `cancel` });
            return;
          case `move`:
            dispatch({ type: `move`, direction: i.direction });
            return;
          case `submit`:
            dispatch({ type: `submit` });
            return;
          case `repaint`:
            this.#cn();
            return;
          case void 0:
            break;
        }
        if (t.type === `left` || t.type === `right`) {
          dispatch({ type: `adjust`, direction: t.type });
          return;
        }
        if (t.type === `tab`) {
          dispatch({ type: `adjust`, direction: `right` });
          return;
        }
        if (t.type === `backspace`) {
          dispatch({ type: `backspace` });
          return;
        }
        if (t.type === `text`)
          for (let e of t.value.replaceAll(
            `
`,
            ` `,
          ))
            e >= ` ` && e !== `` && dispatch({ type: `char`, char: e });
      }).promise
    );
  }
  async #at(e) {
    let t = this.#st(),
      n = lineOf(``),
      r;
    return (
      (t.question = (t) => {
        let i = { message: e.message, editor: n, mask: e.mask === !0 };
        return (
          e.placeholder === void 0
            ? e.defaultValue !== void 0 && (i.placeholder = e.defaultValue)
            : (i.placeholder = e.placeholder),
          e.notices !== void 0 && (i.notices = e.notices),
          r !== void 0 && (i.error = r),
          renderTextQuestion(i, this.#i, t, this.#re)
        );
      }),
      this.#Pt(),
      this.#cn(),
      await this.#ut(
        (t, i) => {
          let apply = (e) => {
              ((n = e), (r = void 0), this.#It(), this.#cn());
            },
            a = applyLineEditorKey(n, t);
          if (a !== void 0) {
            apply(a);
            return;
          }
          switch (t.type) {
            case `ctrl-c`:
            case `escape`:
              i(void 0);
              return;
            case `ctrl-r`:
              this.#cn();
              return;
            case `enter`: {
              let t = n.text.length > 0 ? n.text : (e.defaultValue ?? ``),
                a = e.validate?.(t);
              if (a !== void 0) {
                ((r = a), this.#cn());
                return;
              }
              i(t);
              return;
            }
            default:
              return;
          }
        },
        () => this.#Ft(),
      ).promise
    );
  }
  async #ot(e) {
    let t = this.#st();
    return (
      (t.question = (t) =>
        renderAcknowledgeQuestion(
          { message: e.message, lines: e.lines },
          this.#i,
          t,
        )),
      this.#cn(),
      await this.#ut((e, t) => {
        switch (e.type) {
          case `enter`:
          case `escape`:
          case `ctrl-c`:
            t();
            return;
          case `ctrl-r`:
            this.#cn();
            return;
          default:
            return;
        }
      }).promise
    );
  }
  #st() {
    return (
      this.#Ct(),
      (this.#L = !1),
      (this.#G = { kind: `idle` }),
      (this.#q = ``),
      this.#ct()
    );
  }
  #ct() {
    return (
      this.#Me === void 0 &&
        (this.#Me = {
          title: ``,
          indicator: { kind: `spinner` },
          lines: [],
          outputBuffer: [],
          implicit: !0,
        }),
      this.#Me
    );
  }
  #lt() {
    (this.#Me?.implicit === !0
      ? (this.#Me = void 0)
      : this.#Me !== void 0 &&
        ((this.#Me.question = void 0), (this.#Me.hideLinesWhileQuestion = !1)),
      (this.#ue = void 0),
      this.#Dt(),
      this.#Me !== void 0 && this.#ft(),
      this.#cn());
  }
  #ut(e, t) {
    let n = !1,
      r,
      i,
      a = new Promise((e, t) => {
        ((r = e), (i = t));
      }),
      settle = (e) => {
        n || ((n = !0), t?.(), this.#lt(), r(e));
      },
      reject = (e) => {
        n || ((n = !0), t?.(), this.#lt(), i(e));
      };
    return (
      this.#Mt(),
      (this.#ue = (t) => {
        (t.type === `ctrl-c` && this.#yt(), e(t, settle, reject));
      }),
      this.#Et(),
      { promise: a, settle }
    );
  }
  #dt(e) {
    let t,
      n = new Promise((e) => {
        t = e;
      });
    return (
      (this.#Ue = t),
      this.#ft(e?.interruptible ?? !0),
      {
        promise: n,
        dispose: () => {
          this.#Ue === t && ((this.#Ue = void 0), this.#pt());
        },
      }
    );
  }
  #ft(e = !0) {
    if (this.#Ue === void 0) return;
    let consumer = (t) => {
      if (e && (t.type === `ctrl-c` || t.type === `escape`)) {
        t.type === `ctrl-c` && this.#yt();
        let e = this.#Ue;
        ((this.#Ue = void 0), this.#pt(), e?.());
        return;
      }
      t.type === `ctrl-r` && this.#cn();
    };
    ((this.#We = consumer), this.#Mt(), (this.#ue = consumer), this.#Et());
  }
  #pt() {
    this.#We !== void 0 &&
      (this.#ue === this.#We && this.#Dt(), (this.#We = void 0));
  }
  #mt(e) {
    let t =
      e === void 0
        ? void 0
        : typeof e == `string`
          ? {
              kind: `progress`,
              text: stripTerminalControls(e),
              startedAtMs: Date.now(),
            }
          : {
              kind: `external-action`,
              text: stripTerminalControls(e.text),
              emphasis: stripTerminalControls(e.emphasis),
              startedAtMs: Date.now(),
            };
    if (this.#Me !== void 0) {
      ((this.#Me.status = t),
        t === void 0 && (this.#Me.preview = void 0),
        this.#cn());
      return;
    }
    if (!(this.#L || this.#W)) {
      if (t === void 0) {
        ((this.#G = { kind: `idle` }),
          (this.#J = void 0),
          this.#zt(),
          this.#cn());
        return;
      }
      (this.#Ct(), this.#Rt(), (this.#J = t.text), this.#cn());
    }
  }
  #ht(e, t) {
    let n = stripTerminalControls(e);
    if (n.trim().length === 0) return;
    let r = this.#Me;
    if (r !== void 0) {
      if (((r.preview = void 0), t === `warning` || t === `error`))
        for (let e of r.outputBuffer)
          r.lines.push({ text: e, tone: `info`, evidence: !0 });
      ((r.outputBuffer = []), r.lines.push({ text: n, tone: t }), this.#cn());
      return;
    }
    (this.#Ct(),
      this.#Bt({ kind: `flow`, title: t, body: n, live: !1 }),
      this.#cn());
  }
  #gt(e) {
    let t = this.#Me;
    t !== void 0 &&
      ((t.lines = []),
      (t.outputBuffer = []),
      (t.preview = void 0),
      (t.summary =
        e === void 0
          ? void 0
          : {
              headline: stripTerminalControls(e.headline),
              facts: e.facts.map((e) => ({
                label: stripTerminalControls(e.label),
                value: stripTerminalControls(e.value),
              })),
            }),
      this.#cn());
  }
  #_t(e) {
    let t = stripTerminalControls(e);
    if (t.trim().length === 0) return;
    let n = this.#Me;
    if (n === void 0) {
      this.#ht(t, `info`);
      return;
    }
    ((n.preview = t),
      n.outputBuffer.push(t),
      n.outputBuffer.length > 40 && n.outputBuffer.shift(),
      this.#cn());
  }
  async #vt(e) {
    ((this.#de = ``),
      this.#Mt(),
      (this.#Ue = void 0),
      this.#pt(),
      this.#Dt(),
      this.#zt(),
      this.#n.clear(),
      this.#An(),
      this.#r.enter({ cursor: `visible`, mouse: !1 }),
      this.#e.isTTY && this.#e.setRawMode?.(!1),
      this.#e.pause());
    try {
      return await e();
    } finally {
      (this.#r.exit(),
        this.#e.isTTY && this.#e.setRawMode?.(!0),
        this.#e.resume(),
        (this.#de = ``),
        this.#Mt(),
        this.#n.hideCursor(),
        this.#kn(),
        this.#Me !== void 0 && (this.#Lt(), this.#ft()),
        this.#n.reset(),
        this.#cn());
    }
  }
  setSessionId(e) {
    this.#ze = e;
  }
  shutdown() {
    if ((this.#Tt(), this.#Z && !this.#Q)) {
      this.#Q = !0;
      let e =
        this.#ze === void 0 ? `` : ` ${this.#i.glyph.dot} session ${this.#ze}`;
      this.#t.write(`${this.#i.colors.dim(`${eveVersionTag()}${e}`)}\n`);
    }
  }
  suspendPromptForInput() {
    ((this.#U = { cursor: this.#F, text: this.#P }), this.#Tt());
  }
  requestInterrupt() {
    ((this.#$ = !0),
      this.#Me !== void 0 && this.#ue?.({ type: `ctrl-c` }),
      this.#he?.(),
      this.#Tt());
  }
  exitRequested() {
    return this.#ee;
  }
  #yt() {
    ((this.#ee = !0), this.#ne?.());
  }
  async #bt(e) {
    if (this.#Ge !== void 0 || !this.#X) return;
    let t = new TraceViewerSession({
      ...e,
      theme: this.#i,
      dimensions: () => ({ width: this.#Dn(), height: this.#On() }),
      paint: (e) => this.#r.paint(e, this.#On()),
      tracingDisabled: process.env.EVE_TRACES === `off`,
      copyText: (e) => copyTextToClipboard(e, (e) => this.#r.writeRaw(e)),
      terminalBackground: this.#Ke,
    });
    ((this.#Ge = t),
      this.#r.enter(),
      this.#i.color && this.#r.writeRaw(BACKGROUND_COLOR_QUERY),
      await new Promise((e) => {
        ((this.#St = e),
          (this.#ue = (e) => {
            t.handleKey(e) === `close` && this.#xt();
          }),
          this.#Et(),
          t.start());
      }));
  }
  #xt() {
    let e = this.#Ge;
    if (e === void 0) return;
    ((this.#Ge = void 0),
      e.dispose(),
      this.#Dt(),
      this.#r.exit(),
      this.#n.hideCursor(),
      this.#cn(),
      this.#n.showCursor());
    let t = this.#St;
    ((this.#St = void 0), t?.());
  }
  #St;
  #Ct(e) {
    ((this.#Y = e?.title ?? this.#Y),
      e?.contextSize !== void 0 && (this.#be = e.contextSize),
      !this.#X &&
        ((this.#X = !0),
        (this.#Z = !0),
        this.#n.reset(),
        this.#n.hideCursor(),
        this.#kn(),
        this.#e.isTTY &&
          (this.#e.setRawMode?.(!0),
          this.#e.resume(),
          this.#n.emitBracketedPaste(!0)),
        (this.#me = () => this.#cn()),
        this.#t.on(`resize`, this.#me),
        process.on(`exit`, this.#wt)));
  }
  #wt = () => {
    this.#X &&
      (this.#r.exit(),
      this.#e.isTTY &&
        (this.#n.emitBracketedPaste(!1), this.#e.setRawMode?.(!1)),
      this.#n.showCursor());
  };
  #Tt() {
    this.#xt();
    let e = this.#K;
    if (
      ((this.#K = void 0),
      e?.(interruptedError()),
      this.#Dt(),
      this.#Ft(),
      this.#zt(),
      this.#ce !== void 0 && (clearTimeout(this.#ce), (this.#ce = void 0)),
      (this.#le = !1),
      this.#X)
    ) {
      this.#Rn();
      for (let e of this.#m)
        e.kind === `log` && e.id === void 0 && (e.live = !1);
      (this.#cn(),
        this.#n.clear(),
        this.#n.showCursor(),
        this.#An(),
        this.#n.newline(),
        this.#e.isTTY &&
          (this.#n.emitBracketedPaste(!1),
          this.#e.setRawMode?.(!1),
          this.#e.pause()),
        (this.#me &&= (this.#t.off(`resize`, this.#me), void 0)),
        process.off(`exit`, this.#wt),
        (this.#X = !1));
    }
  }
  #Et() {
    (this.#e.off(`data`, this.#Ot),
      this.#e.on(`data`, this.#Ot),
      this.#de.length > 0 &&
        queueMicrotask(() => {
          this.#ue !== void 0 &&
            this.#de.length > 0 &&
            (this.#At(), this.#kt());
        }));
  }
  #Dt() {
    (this.#e.off(`data`, this.#Ot), this.#Mt(), (this.#ue = void 0));
  }
  #Ot = (e) => {
    (this.#Mt(), (this.#de += this.#fe.write(e)), this.#At(), this.#kt());
  };
  #kt() {
    if (this.#de === `\x1B`) {
      ((this.#pe = setTimeout(() => {
        this.#de === `\x1B` &&
          ((this.#de = ``), this.#ue?.({ type: `escape` }));
      }, 30)),
        this.#pe.unref?.());
      return;
    }
    if (isIncompletePaste(this.#de)) {
      let e = this.#de;
      ((this.#pe = setTimeout(() => {
        if (this.#de !== e) return;
        let t = sanitizePastedText(stripPasteStart(e));
        ((this.#de = ``),
          t.length > 0 &&
            this.#ue?.({ type: `text`, value: t, framing: `bracketed-paste` }));
      }, incompletePasteFlushMs)),
        this.#pe.unref?.());
      return;
    }
    if (isIncompleteOsc(this.#de)) {
      let e = this.#de;
      ((this.#pe = setTimeout(() => {
        this.#de === e && (this.#de = ``);
      }, incompletePasteFlushMs)),
        this.#pe.unref?.());
    }
  }
  #At() {
    for (; this.#de.length > 0; ) {
      let e = nextKey(this.#de);
      if (e.incomplete) return;
      if (
        ((this.#de = this.#de.slice(e.consumed)),
        !(e.key === void 0 || e.key.type === `ignore`))
      ) {
        if (e.key.type === `osc`) {
          this.#jt(e.key.value);
          continue;
        }
        this.#ue?.(e.key);
      }
    }
  }
  #jt(e) {
    let t = parseBackgroundColorReply(e);
    t !== void 0 && ((this.#Ke = t), this.#Ge?.setTerminalBackground(t));
  }
  #Mt() {
    this.#pe &&= (clearTimeout(this.#pe), void 0);
  }
  #Nt(e) {
    switch (e.type) {
      case `ctrl-l`:
      case `ctrl-r`:
        this.#cn();
        break;
      case `enter`: {
        let e = this.#U.text;
        if (e.trim().length === 0) break;
        if (parsePromptCommand(e)?.type === `cancel` && this.#Le !== void 0) {
          ((this.#U = EMPTY_LINE),
            this.#Ie.requestCancellation(),
            (this.#Ve = !0),
            this.renderCommandInvocation(e.trim()),
            this.renderCommandResult(`Turn cancellation requested.`),
            this.#Le(),
            this.#cn());
          break;
        }
        (this.#Ie.enqueue(e) && (this.#U = EMPTY_LINE), this.#cn());
        break;
      }
      case `ctrl-c`:
      case `escape`:
        if (this.#Ie.idle && this.#Le === void 0) break;
        (this.#Ie.handleEscape(), (this.#Ve = !0), this.#Le?.(), this.#cn());
        break;
      default: {
        let t = applyLineEditorKey(this.#U, e, { multiline: !0 });
        t !== void 0 && ((this.#U = t), this.#cn());
        break;
      }
    }
  }
  #Pt() {
    (this.#Ft(),
      this.#It(),
      (this.#oe = setInterval(() => {
        ((this.#re = !this.#re), this.#cn());
      }, 500)),
      this.#oe.unref?.());
  }
  #Ft() {
    ((this.#oe &&= (clearInterval(this.#oe), void 0)), (this.#re = !0));
  }
  #It() {
    this.#re = !0;
  }
  #Lt() {
    (this.#zt(),
      (this.#se = setInterval(() => {
        ((this.#ie += 1), this.#cn());
      }, 90)),
      this.#se.unref?.());
  }
  #Rt() {
    let e = Date.now();
    ((this.#ae = e),
      (this.#G = { kind: `waiting`, startedAtMs: e }),
      this.#Lt());
  }
  #zt() {
    this.#se &&= (clearInterval(this.#se), void 0);
  }
  #Bt(e) {
    (e.id !== this.#Oe?.id && this.#Rn(), (e.updateSeq = ++this.#b));
    let t =
      e.subagentCallId !== void 0 && this.#S.has(e.subagentCallId)
        ? -1
        : this.#m.findIndex(
            (e) => e.subagentCallId !== void 0 && this.#S.has(e.subagentCallId),
          );
    (t < 0 ? this.#m.push(e) : this.#m.splice(t, 0, e),
      e.id && this.#h.set(e.id, e));
  }
  #Vt(e) {
    ((this.#V = !0),
      this.#Bt({ kind: `user`, body: stripTerminalControls(e), live: !1 }),
      this.#cn());
  }
  #Ht() {
    let e = this.#H.settle();
    if (e === void 0 || (e.elapsedMs <= 1e4 && e.inputTokens <= 2e4)) return;
    let t = `Done in ${this.#bn(e.elapsedMs)}`,
      n = this.#ye ?? 0;
    if (this.#be !== void 0 && this.#be > 0 && n > 0) {
      let e = Math.round((n / this.#be) * 100);
      t += ` ${this.#i.glyph.dot} ${e}% context`;
    }
    this.#Bt({ kind: `turn-stats`, body: t, live: !1 });
  }
  #Ut(e) {
    if (e == null) return;
    let t = this.#Be;
    if (((this.#Be = void 0), this.#Ae === e)) {
      this.#Ae = void 0;
      return;
    }
    let n = { kind: `user`, body: stripTerminalControls(e), live: !1 };
    (t !== void 0 && (n.promptOrigin = t), this.#Bt(n));
  }
  #Wt(e, t, n = {}) {
    let r = stripTerminalControls(e),
      i = stripTerminalControls(t),
      a = n.detail === void 0 ? void 0 : stripTerminalControls(n.detail),
      o = n.hint === void 0 ? void 0 : stripTerminalControls(n.hint),
      s = { source: `workflow`, summary: `${r}: ${i}`, detail: a ?? i };
    this.#d?.append(o === void 0 ? s : { ...s, hint: o });
    let c = { kind: `error`, title: r, body: i, live: !1 };
    (o !== void 0 && (c.hint = o),
      a !== void 0 &&
        (c.detail = this.#d === void 0 ? a : `details: ${this.#d.displayPath}`),
      this.#Bt(c),
      this.#cn());
  }
  #Gt(e, t) {
    if (this.#T.has(e)) return;
    this.#T.add(e);
    let n = stripTerminalControls(t),
      r = this.#x.get(n) ?? [];
    if ((r.push(e), this.#x.set(n, r), r.length === 2)) {
      let e = this.#h.get(subagentHeaderId(r[0]));
      e !== void 0 && (e.subtitle = `#1`);
    }
    let i = {
      id: subagentHeaderId(e),
      kind: `subagent`,
      subagentCallId: e,
      title: n,
      live: !0,
    };
    (r.length > 1 && (i.subtitle = `#${r.length}`), this.#Bt(i));
  }
  #Kt(e) {
    if (e.id && this.#g.has(e.id)) return;
    let t = e.id ? this.#h.get(e.id) : void 0;
    if (t) {
      (Object.assign(t, e), (t.updateSeq = ++this.#b));
      return;
    }
    this.#Bt(e);
  }
  #qt(e) {
    if (e.id && this.#g.has(e.id)) return;
    let t = e.id ? this.#h.get(e.id) : void 0;
    if (t !== void 0) {
      (Object.assign(t, e), (t.updateSeq = ++this.#b));
      return;
    }
    let n = e.subagentCallId;
    if (n === void 0) {
      this.#Bt(e);
      return;
    }
    (e.id !== this.#Oe?.id && this.#Rn(), (e.updateSeq = ++this.#b));
    let r = -1;
    for (let e = 0; e < this.#m.length; e += 1)
      this.#m[e]?.subagentCallId === n && (r = e);
    (this.#m.splice(r < 0 ? this.#m.length : r + 1, 0, e),
      e.id !== void 0 && this.#h.set(e.id, e));
  }
  #Jt(e) {
    ((this.#m = this.#m.filter((t) => t.id !== e)), this.#h.delete(e));
  }
  #Yt() {
    for (let e of this.#m)
      (e.subagentCallId !== void 0 && this.#C.has(e.subagentCallId)) ||
        e.status === `approval` ||
        e.status === `running` ||
        (e.kind === `connection-auth` && e.live) ||
        (e.live = !1);
  }
  #Xt(e, t, n) {
    switch (e.type) {
      case `step-finish`:
        (this.#d?.recordStepUsage(e.usage),
          e.usage !== void 0 && this.#H.addUsage(e.usage),
          this.#rn(n),
          this.#sn(e.usage),
          this.#cn());
        break;
      case `assistant-delta`: {
        let t = (n.text.get(e.id) ?? ``) + stripTerminalControls(e.delta);
        (n.text.set(e.id, t), this.#Zt(e.id, t, !0));
        break;
      }
      case `assistant-complete`: {
        let t = n.text.get(e.id) ?? ``,
          r =
            e.text !== void 0 && t.length === 0
              ? stripTerminalControls(e.text ?? ``)
              : t;
        (n.text.set(e.id, r), this.#Zt(e.id, r, !1));
        break;
      }
      case `reasoning-delta`: {
        if (t.reasoning === `hidden`) break;
        let r = (n.reasoning.get(e.id) ?? ``) + stripTerminalControls(e.delta);
        if ((n.reasoning.set(e.id, r), t.reasoning === `full`)) {
          this.#Qt(e.id, r, !0, t);
          break;
        }
        break;
      }
      case `reasoning-complete`: {
        if (t.reasoning === `hidden`) break;
        let r = n.reasoning.get(e.id) ?? ``;
        if (t.reasoning === `full`) {
          this.#Qt(e.id, r, !1, t);
          break;
        }
        break;
      }
      case `tool-call-preparing`:
        if (t.tools === `hidden` || isPanelRoutedTool(e.toolName)) break;
        this.#$t(
          {
            input: void 0,
            preparing: !0,
            status: `running`,
            toolCallId: e.toolCallId,
            toolName: e.toolName,
          },
          t,
          n,
        );
        break;
      case `tool-call`:
        if ((this.#d?.recordToolCall(e.toolName), t.tools === `hidden`)) break;
        this.#$t(
          {
            input: e.input,
            status: `running`,
            toolCallId: e.toolCallId,
            toolName: e.toolName,
          },
          t,
          n,
        );
        break;
      case `tool-approval-request`: {
        if (t.tools === `hidden`) break;
        let r = n.tools.get(e.toolCallId);
        if (r === void 0) break;
        this.#$t({ ...r, status: `approval` }, t, n);
        break;
      }
      case `tool-result`: {
        if (t.tools === `hidden`) break;
        let r = this.#on(e.toolCallId, n);
        if (r === void 0) break;
        this.#$t({ ...r, output: e.output, status: `done` }, t, n);
        break;
      }
      case `tool-error`: {
        let r = this.#on(e.toolCallId, n);
        if (
          (this.#d?.append({
            source: `tool`,
            summary: `${r?.toolName ?? e.toolCallId} failed`,
            detail: e.errorText,
          }),
          t.tools === `hidden` || r === void 0)
        )
          break;
        this.#$t({ ...r, errorText: e.errorText, status: `error` }, t, n);
        break;
      }
      case `tool-rejected`: {
        if (t.tools === `hidden`) break;
        let r = this.#on(e.toolCallId, n);
        if (r === void 0) break;
        this.#$t({ ...r, errorText: e.reason, status: `denied` }, t, n);
        break;
      }
      case `error`:
        this.#Wt(`Error`, e.errorText, { detail: e.detail, hint: e.hint });
        break;
      case `turn-cancelled`:
        if (((n.cancelled = !0), !n.restoreCancelledPrompt)) break;
        ((this.#Re = !0),
          !this.#Ve &&
            this.#He !== void 0 &&
            this.#U.text.length === 0 &&
            ((this.#U = lineOf(this.#He)),
            this.renderNotice(
              `The turn was cancelled from outside this prompt — the message was restored to the input.`,
            )));
        break;
      case `finish`:
        (this.#sn(e.usage), this.#cn());
        break;
    }
  }
  #Zt(e, t, n) {
    let r = stripTerminalControls(t).trim();
    r.length !== 0 &&
      (this.#Kt({ id: e, kind: `assistant`, body: r, live: n }), this.#cn());
  }
  #Qt(e, t, n, r) {
    let i = stripTerminalControls(t).trim();
    i.length !== 0 &&
      (this.#Kt({
        id: e,
        kind: `reasoning`,
        body: i,
        collapsed: collapseReasoning(r.reasoning, n),
        live: n,
      }),
      this.#cn());
  }
  #$t(e, t, n) {
    if (
      (n.tools.set(e.toolCallId, e),
      this.#v.has(e.toolCallId) ||
        this.#in(e) ||
        toolBaseName(e.toolName) === `ask_question`)
    )
      return;
    let r = toolSectionId(e.toolCallId);
    this.#y.set(e.toolCallId, r);
    let i = this.#en(e);
    (this.#Kt(renderNativeToolBlock(e, r, t.tools === `full`, i)),
      this.#an(n),
      this.#cn());
  }
  #en(e) {
    e.output !== void 0 && this.#w.observeRead(e.output);
    let t = {};
    this.#tn(e.toolName) && (t.isSubagent = !0);
    let n = readWriteFileInput(e.toolName, e.input);
    if (n === void 0) return t.isSubagent === !0 ? t : void 0;
    let r = this.#w.observeWrite({
      path: n.path,
      content: n.content,
      callId: e.toolCallId,
    });
    r !== void 0 && (t.previousContent = r);
    let i = writeExistedFlag(e.output);
    return (i !== void 0 && (t.existed = i), t);
  }
  #tn(e) {
    let t = this.#E?.info?.subagents.local;
    if (t === void 0 || t.length === 0) return !1;
    let n = toolBaseName(e);
    return t.some((e) => e.name === n);
  }
  #nn(e) {
    for (let t of e.tools.keys()) {
      if (this.#v.has(t)) continue;
      let e = this.#y.get(t) ?? toolSectionId(t),
        n = this.#h.get(e);
      n?.kind === `tool` &&
        n.status === `running` &&
        ((n.status = `error`), (n.result = `interrupted`), (n.live = !1));
    }
  }
  #rn(e) {
    for (let [t, n] of e.tools) {
      if (n.preparing !== !0) continue;
      e.tools.delete(t);
      let r = this.#y.get(t) ?? toolSectionId(t);
      (this.#Jt(r), this.#y.delete(t));
    }
  }
  #in(e) {
    let t = readTodoToolItems(e.toolName, e.input);
    if (t === void 0) return !1;
    if (t.length > 0 && allTodoItemsSettled(t)) {
      let e = JSON.stringify(t);
      (this.#Fe !== e &&
        ((this.#Fe = e),
        this.#Bt({
          kind: `todo-list`,
          body: renderFinishedTodoRows(t, this.#Dn(), this.#i).join(`
`),
          live: !1,
        })),
        (this.#Pe = void 0));
    } else ((this.#Pe = t.length > 0 ? t : void 0), (this.#Fe = void 0));
    return (this.#cn(), !0);
  }
  #an(e) {
    let t = [];
    for (let n of e.tools.values()) {
      if (this.#v.has(n.toolCallId)) continue;
      let e = this.#y.get(n.toolCallId) ?? toolSectionId(n.toolCallId),
        r = this.#h.get(e);
      r?.kind === `tool` &&
        t.push({ block: r, active: isActiveToolStatus(n.status) });
    }
    applyCohortLiveness(t);
  }
  #on(e, t) {
    let n = t.tools.get(e);
    if (n !== void 0) return n;
    let r = this.#y.get(e) ?? toolSectionId(e),
      i = this.#h.get(r);
    if (!(i === void 0 || i.kind !== `tool`))
      return {
        errorText:
          i.status === `error` && typeof i.result == `string`
            ? i.result
            : void 0,
        input: i.toolInput,
        output: i.toolOutput,
        status: i.status ?? `running`,
        toolCallId: e,
        toolName: i.toolName ?? i.title ?? `tool`,
      };
  }
  #sn(e) {
    if (e === void 0) return;
    let { inputTokens: t, outputTokens: n } = e;
    if (
      ((t != null || n != null) && (this.#ve = (t ?? 0) + (n ?? 0)),
      (this.#ye = t ?? this.#ye),
      (this.#xe = n ?? this.#xe),
      this.#xe != null && this.#Ce !== void 0)
    ) {
      let e = (Date.now() - this.#Ce) / 1e3;
      e > 0 && (this.#Se = this.#xe / e);
    }
  }
  #cn() {
    if (this.#X) {
      if (this.#ge) {
        this.#_e = !0;
        return;
      }
      this.#ge = !0;
      try {
        do ((this.#_e = !1), this.#ln());
        while (this.#_e);
      } finally {
        this.#ge = !1;
      }
    }
  }
  #ln() {
    if (!this.#X) return;
    if (this.#Ge !== void 0) {
      this.#Ge.repaint();
      return;
    }
    let e = this.#Dn(),
      t = this.#vn(e),
      n = Math.max(1, this.#On() - t.length),
      r = [],
      i = this.#A,
      a = groupToolBlocksForDisplay(this.#m),
      o = 0;
    for (; o < a.length && a[o].display.live === !1; ) o += 1;
    if (o > 0) {
      let e = new Set(a.slice(0, o).flatMap((e) => e.members));
      for (let t = this.#m.length - 1; t >= 0; --t)
        e.has(this.#m[t]) && this.#m.splice(t, 1);
    }
    for (let t of a.slice(0, o)) {
      for (let e of t.members)
        (this.#_.push(e), e.id && (this.#g.add(e.id), this.#h.delete(e.id)));
      if (this.#Bn(t.display)) continue;
      let n = this.#mn(t.display, e, i);
      ((i = previousBlockOf(t.display)),
        (this.#A = i),
        r.push(...n),
        this.#k.push(...n));
    }
    let s = [];
    for (let { display: t } of a.slice(o)) {
      if (this.#Bn(t)) continue;
      let n = this.#mn(t, e, i);
      i = previousBlockOf(t);
      for (let e = 0; e < n.length; e += 1) s.push({ block: t, row: n[e] });
    }
    let c = [
      ...clipLiveRows(
        s.map((e) => e.row),
        n,
        e,
        this.#i,
      ),
      ...t,
    ];
    r.length > 0 ? this.#n.flush(r, c) : this.#n.update(c);
  }
  #un() {
    if (!this.#X) return;
    let e = this.#Dn(),
      t = this.#vn(e),
      n = Math.max(1, this.#On() - t.length),
      r = this.#A,
      i = [];
    for (let { display: t } of groupToolBlocksForDisplay(this.#m)) {
      if (this.#Bn(t)) continue;
      let n = this.#mn(t, e, r);
      ((r = previousBlockOf(t)), i.push(...n));
    }
    let a = [...clipLiveRows(i, n, e, this.#i), ...t];
    (this.#n.clearAll(), this.#n.flush([...this.#pn(), ...this.#k], a));
  }
  logDisplayMode() {
    return this.#p;
  }
  setLogDisplayMode(e) {
    e !== this.#p &&
      ((this.#p = e),
      e === `all` && this.flushDelayedDevBuildErrors(),
      this.#fn(),
      this.#X && this.#un());
  }
  flushDelayedDevBuildErrors() {
    let e = this.#De;
    e !== void 0 &&
      ((this.#De = void 0),
      this.#Bt({ kind: `log`, title: `stderr`, body: e, live: !0 }),
      this.#cn());
  }
  #dn() {
    ((this.#le = !0),
      this.#ce !== void 0 && clearTimeout(this.#ce),
      (this.#ce = setTimeout(() => {
        ((this.#le = !1), (this.#ce = void 0), this.#cn());
      }, 5e3)),
      this.setLogDisplayMode(nextLogDisplayMode(this.#p)),
      this.#cn());
  }
  #fn() {
    let e = this.#Dn();
    this.#k.length = 0;
    let t;
    for (let { display: n } of groupToolBlocksForDisplay(this.#_, {
      logCoalescing: `runs`,
    })) {
      if (this.#Bn(n)) continue;
      let r = this.#mn(n, e, t);
      ((t = previousBlockOf(n)), this.#k.push(...r));
    }
    this.#A = t;
  }
  #pn() {
    let e = this.#E;
    if (e === void 0) return [];
    let t = { name: e.name, theme: this.#i, width: this.#Dn() };
    return (
      e.info !== void 0 && (t.info = e.info),
      e.tip !== void 0 && (t.tip = e.tip),
      buildAgentHeader(t)
    );
  }
  #mn(e, t, n) {
    let r = {
      activityPulse: this.#gn(
        this.#ae,
        this.#i.unicode ? PROGRESS_PULSE_GLYPH : PROGRESS_PULSE_ASCII_GLYPH,
      ),
    };
    n !== void 0 && (r.previous = n);
    let i = renderBlockLines(e, t, this.#i, r);
    return (e.depth ?? 0) === 0 && leadsWithGap(e, n) ? [``, ...i] : i;
  }
  #hn() {
    return this.#i.spinner[this.#ie % this.#i.spinner.length] ?? ``;
  }
  #gn(e, t) {
    return isProgressPulseVisible(Date.now() - e) ? t : ` `;
  }
  #_n(e, t) {
    return e.indicator.kind === `spinner`
      ? { glyph: this.#hn(), color: `yellow` }
      : {
          glyph: this.#gn(
            e.indicator.startedAtMs,
            this.#i.unicode ? PROGRESS_PULSE_GLYPH : PROGRESS_PULSE_ASCII_GLYPH,
          ),
          color: t?.kind === `external-action` ? `yellow` : `green`,
        };
  }
  #vn(e) {
    let n = this.#i.colors,
      r = [``];
    if (this.#je !== void 0)
      return (r.push(...this.#je(e), ``), this.#wn(r, e), r);
    let a = this.#Me;
    if (a !== void 0) {
      let t = this.#_n(a, a.status),
        n;
      if (a.status !== void 0) {
        let { startedAtMs: e, ...r } = a.status,
          i = Date.now() - e,
          o = i >= 5e3 ? ` ${formatTurnDuration(i)}` : ``;
        n = { ...r, text: `${r.text}${o}`, indicator: t };
      }
      let i;
      if (a.question !== void 0) {
        let t = a.question(e);
        ((i = { kind: `question`, rows: t }),
          n !== void 0 && (i = { kind: `question`, rows: t, status: n }));
      } else
        n === void 0
          ? (i =
              a.preview === void 0
                ? { kind: `idle`, indicator: t }
                : { kind: `preview`, text: a.preview, indicator: t })
          : ((i = { kind: `status`, status: n }),
            a.preview !== void 0 &&
              (i = { kind: `status`, status: n, preview: a.preview }));
      let o = {
        title: a.title,
        lines:
          a.summary === void 0
            ? a.hideLinesWhileQuestion === !0
              ? []
              : a.lines
            : [
                { text: a.summary.headline, tone: `success` },
                ...a.summary.facts.map((e) => ({
                  text: `${e.label}: ${e.value}`,
                  tone: `info`,
                })),
              ],
        content: i,
      };
      return (r.push(...renderFlowPanel(o, this.#i, e)), this.#Tn(r, e), r);
    }
    (this.#Ne !== void 0 &&
      r.push(...renderAttentionRows(this.#Ne, e, this.#i), ``),
      this.#Pe !== void 0 &&
        r.push(
          ...renderTodoPanelRows({
            items: this.#Pe,
            width: e,
            theme: this.#i,
            working: this.#W || this.#G.kind === `waiting`,
            pulse: this.#gn(
              this.#ae,
              this.#i.unicode
                ? PROGRESS_PULSE_GLYPH
                : PROGRESS_PULSE_ASCII_GLYPH,
            ),
          }),
          ``,
        ));
    let o = renderMessageQueueRows({
      view: this.#Ie.view(),
      width: e,
      theme: this.#i,
      working: this.#W,
    });
    if ((o.length > 0 && r.push(...o, ``), this.#L)) {
      let i = this.#R === void 0 ? void 0 : inlineCommandHint(this.#R);
      (i === void 0 &&
        this.#R !== void 0 &&
        isTypeaheadOpen(this.#R) &&
        r.push(...renderCommandSuggestions(this.#R, this.#i, e)),
        this.#te && r.push(clip(n.dim(`Press Ctrl+C again to exit`), e), ``));
      let a = isPromptControlCommand(this.#P),
        o = i ? n.dim(` ${i}`) : ``,
        s = [];
      this.#wn(s, e);
      let u = Math.max(1, this.#On() - 1 - r.length - 1 - s.length),
        f = {
          text: this.#P,
          cursor: this.#F,
          width: e,
          theme: this.#i,
          caretVisible: this.#re,
          isCommand: a,
          ghost: o,
          maxRows: u,
        };
      return (
        this.#z &&
          this.#P.length === 0 &&
          (f.placeholder = this.#V
            ? ``
            : promptPlaceholder(Date.now() - this.#B)),
        r.push(...promptInputRows(f)),
        r.push(...s),
        r
      );
    }
    let s = this.#G.kind === `waiting` && this.#J === void 0;
    if (this.#W || s) {
      (r.push(this.#yn(e)), this.#Sn(r, e));
      let t = [];
      return (
        this.#wn(t, e),
        !this.#W && t.length > 0 && r.push(``),
        r.push(...t),
        r
      );
    }
    if (this.#U.text.length > 0)
      return (this.#Cn(r, e, { inert: !1 }), this.#wn(r, e), r);
    let u = this.#J ?? (this.#q.length > 0 ? this.#q : `Ready`),
      f = this.#En(),
      p = n.dim(this.#i.glyph.dot),
      m = f ? `${p} ${u}  ${n.dim(this.#i.glyph.dot)}  ${f}` : `${p} ${u}`;
    return (r.push(clip(m, e)), this.#wn(r, e), r);
  }
  #yn(e) {
    let t = this.#i.colors,
      n = this.#gn(
        this.#ae,
        this.#i.unicode ? PROGRESS_PULSE_GLYPH : PROGRESS_PULSE_ASCII_GLYPH,
      ),
      r = this.#G,
      i =
        this.#H.startedAtMs ??
        this.#Ce ??
        (r.kind === `waiting` ? r.startedAtMs : Date.now()),
      a = Date.now() - i,
      o = `${typewriterText(`Working for`, a, 80)} ${this.#bn(a)}`;
    return clip(`${t.yellow(n)} ${t.dim(o)}`, e);
  }
  #bn(e) {
    return `${formatTurnDuration(e)}${this.#xn()}`;
  }
  #xn() {
    let { inputTokens: e, outputTokens: t } = this.#H.usage;
    return e === 0 && t === 0
      ? ``
      : ` ${this.#i.glyph.dash.repeat(2)} ${formatTokenFlow({ inputTokens: e, outputTokens: t }, this.#i.glyph)}`;
  }
  #Sn(e, t) {
    this.#W && this.#Cn(e, t, { inert: !0 });
  }
  #Cn(e, t, n) {
    e.push(``);
    let r = {
      text: this.#U.text,
      cursor: this.#U.cursor,
      width: t,
      theme: this.#i,
      caretVisible: !0,
      isCommand: !1,
      ghost: ``,
      maxRows: 4,
      inert: n.inert,
    };
    (n.inert && this.#U.text.length === 0 && (r.placeholder = ``),
      e.push(...promptInputRows(r)));
  }
  #wn(e, t) {
    let n = this.#N === void 0 ? `` : `  `,
      r = Math.max(1, t - n.length),
      i = { theme: this.#i, width: r };
    this.#le && (i.logLevel = this.#p);
    let a = this.#E?.serverUrl;
    if (a !== void 0 && this.#N === void 0) {
      let e = new URL(a).port;
      e.length > 0 && (i.serverPort = e);
    }
    let o = this.#E?.info?.agent.model;
    (o?.id !== void 0 && (i.model = o.id),
      o?.reasoning !== void 0 &&
        o.reasoning !== `provider-default` &&
        (i.reasoning = o.reasoning),
      readGatewayServiceTier(o?.providerOptions).kind === `priority` &&
        (i.fastMode = !0));
    let s = o?.endpoint;
    (s !== void 0 && (i.endpoint = s),
      this.#M !== void 0 && (i.vercel = this.#M),
      this.#N !== void 0 && (i.remote = this.#N));
    let c = buildStatusLine(i);
    c !== void 0 && e.push(clip(`${n}${c}`, t));
  }
  #Tn(e, t) {
    if (this.#N === void 0) return;
    let n = Math.max(1, t - 2),
      r = buildStatusLine({ remote: this.#N, theme: this.#i, width: n });
    r !== void 0 && e.push(``, clip(`  ${r}`, t));
  }
  #En() {
    let e = this.#i.colors,
      t = [],
      n = formatAssistantResponseStats(
        {
          totalTokens: this.#ve,
          outputTokens: this.#xe,
          tokensPerSecond: this.#Se,
        },
        this.#l,
      );
    return (
      n && t.push(n),
      t.length > 0 ? e.dim(t.join(`  ${this.#i.glyph.dot}  `)) : ``
    );
  }
  #Dn() {
    return Math.max(20, this.#t.columns || 80);
  }
  #On() {
    return Math.max(8, this.#t.rows || 24);
  }
  #kn() {
    if (this.#we !== void 0 || !this.#u) return;
    ((this.#Te = ``), (this.#Ee = ``));
    let capture = (e, t) => {
        let n = e.write.bind(e);
        return (
          (e.write = (e, n, r) => {
            let i = typeof n == `string` ? n : void 0,
              a = typeof n == `function` ? n : r;
            return (this.#Mn(t, chunkToString(e, i)), a?.(), !0);
          }),
          () => {
            e.write = n;
          }
        );
      },
      e = capture(process.stdout, `stdout`),
      t = capture(process.stderr, `stderr`);
    (this.#d?.subscribeLogRecords((e) => this.#jn(e)),
      (this.#we = () => {
        (this.#d?.unsubscribeLogRecords(), e(), t());
      }));
  }
  #An() {
    let e = this.#we;
    e !== void 0 &&
      ((this.#we = void 0),
      e(),
      this.#Te.length > 0 &&
        (this.#d?.append({ source: `stdout`, detail: this.#Te }),
        this.#zn(`stdout`) && process.stdout.write(`${this.#Te}\n`),
        (this.#Te = ``)),
      this.#Ee.length > 0 &&
        (this.#d?.append({ source: `stderr`, detail: this.#Ee }),
        this.#zn(`stderr`) && process.stderr.write(`${this.#Ee}\n`),
        (this.#Ee = ``)));
  }
  #jn(e) {
    let t = e.fields === void 0 ? `` : ` ${JSON.stringify(e.fields)}`;
    (this.#Pn(`[eve:${e.namespace}] ${e.message}${t}`), this.#cn());
  }
  #Mn(e, t) {
    let n = (e === `stdout` ? this.#Te : this.#Ee) + t;
    if (e === `stdout` && parseDevRebuildLogLine(n.trimEnd()) !== void 0) {
      ((this.#Te = ``),
        this.#d?.append({ source: e, detail: n.trimEnd() }),
        this.#Nn(n.trimEnd()),
        this.#cn());
      return;
    }
    let r = n.lastIndexOf(`
`),
      i = r === -1 ? n : n.slice(r + 1);
    if ((e === `stdout` ? (this.#Te = i) : (this.#Ee = i), r === -1)) return;
    let a = stripAnsi(n.slice(0, r)).replace(/\s+$/u, ``);
    a.trim().length !== 0 &&
      (this.#d?.append({ source: e, detail: a }),
      e === `stdout` ? this.#Nn(a) : this.#Pn(a),
      this.#cn());
  }
  #Nn(e) {
    let t = [],
      flushPending = () => {
        if (t.length === 0) return;
        let e = t.join(`
`);
        ((t = []),
          e.trim().length !== 0 &&
            this.#Bt({ kind: `log`, title: `stdout`, body: e, live: !0 }));
      };
    for (let n of e.split(`
`)) {
      let e = parseSandboxLogLine(n.trimEnd());
      if (e !== void 0) {
        (flushPending(), this.#Bt({ kind: `sandbox`, body: e, live: !1 }));
        continue;
      }
      let r = parseDevRebuildLogLine(n.trimEnd());
      if (r === void 0) {
        t.push(n);
        continue;
      }
      (flushPending(), this.#In(r, n.trimEnd()));
    }
    flushPending();
  }
  #Pn(e) {
    let t = e.split(`
`),
      n = t.findIndex(
        (e) => parseDevRebuildLogLine(e.trimEnd())?.kind === `failed`,
      );
    if (n === -1) {
      if (this.#d === void 0) {
        this.#Bt({ kind: `log`, title: `stderr`, body: e, live: !0 });
        return;
      }
      let t = presentDiagnostic(e, this.#d.displayPath);
      if (t.kind === `inline`) {
        this.#Bt({ kind: `log`, title: `stderr`, body: t.text, live: !0 });
        return;
      }
      (this.#Bt({
        kind: `log`,
        title: `stderr`,
        body: formatStoredDiagnostic(t),
        logVisibility: `stderr-only`,
        live: !0,
      }),
        this.#Bt({
          kind: `log`,
          title: `stderr`,
          body: e,
          logVisibility: `all-only`,
          live: !0,
        }));
      return;
    }
    let r = t.slice(0, n).join(`
`);
    r.trim().length > 0 &&
      this.#Bt({ kind: `log`, title: `stderr`, body: r, live: !0 });
    let i = t.slice(n).join(`
`);
    this.#Fn(i);
  }
  #Fn(e) {
    if (this.#p === `all`) {
      if (e.trim().length === 0) return;
      this.#Bt({ kind: `log`, title: `stderr`, body: e, live: !0 });
      return;
    }
    this.#De = e;
  }
  #In(e, t) {
    let n = this.#Ln();
    if (e.kind === `failed`) {
      this.#Fn(t);
      return;
    }
    if (e.kind === `rebuilding`) {
      let t = summarizeChangedFiles(e.events, e.more);
      if (n !== void 0) {
        ((n.state.summary = t),
          (n.block.body = formatDevRebuildStatus(t, `rebuilding`)));
        return;
      }
      let r = `dev-rebuild:${this.#ke}`;
      ((this.#ke += 1),
        (this.#Oe = { id: r, summary: t }),
        this.#Bt({
          kind: `log`,
          id: r,
          title: `stdout`,
          body: formatDevRebuildStatus(t, `rebuilding`),
          live: !0,
        }));
      return;
    }
    if (n !== void 0) {
      ((n.block.body = formatDevRebuildStatus(n.state.summary, e.kind)),
        e.kind === `rebuilt` && (this.#De = void 0));
      return;
    }
    (e.kind === `rebuilt` && (this.#De = void 0),
      this.#Bt({ kind: `log`, title: `stdout`, body: t, live: !0 }));
  }
  #Ln() {
    let e = this.#Oe;
    if (e === void 0) return;
    let t = this.#h.get(e.id);
    if (!(t === void 0 || t.live !== !0)) return { state: e, block: t };
  }
  #Rn() {
    let e = this.#Oe;
    if (e === void 0) return;
    this.#Oe = void 0;
    let t = this.#h.get(e.id);
    t !== void 0 && (t.live = !1);
  }
  #zn(e) {
    switch (this.#p) {
      case `none`:
        return !1;
      case `stderr`:
        return e === `stderr`;
      case `sandbox`:
        return e === `sandbox`;
      case `all`:
        return !0;
    }
  }
  #Bn(e) {
    return e.kind === `sandbox`
      ? !this.#zn(`sandbox`)
      : e.kind === `log`
        ? e.logVisibility === `stderr-only`
          ? this.#p !== `stderr`
          : e.logVisibility === `all-only`
            ? this.#p !== `all`
            : !this.#zn(e.title === `stderr` ? `stderr` : `stdout`)
        : !1;
  }
};
function chunkToString(e, t) {
  return typeof e == `string` ? e : Buffer.from(e).toString(t);
}
async function* iterateTUIStream(e) {
  if (e instanceof ReadableStream) {
    let t = e.getReader();
    try {
      for (;;) {
        let { done: e, value: n } = await t.read();
        if (e) return;
        yield n;
      }
    } finally {
      t.releaseLock();
    }
    return;
  }
  yield* e;
}
function clip(e, t) {
  return clipVisible(e, t);
}
function promptInputRows({
  text: e,
  cursor: t,
  width: n,
  theme: r,
  caretVisible: i,
  isCommand: a,
  ghost: o,
  maxRows: s,
  placeholder: c,
  inert: l,
}) {
  let u = r.colors;
  if (e.length === 0 && c !== void 0) {
    let e = renderInputWithBlockCursor({
      ...visibleLine(
        { text: c, cursor: 0 },
        Math.max(1, n - 3),
        r.glyph.ellipsis,
      ),
      visible: i,
      inverse: u.inverse,
      render: (e) => u.dim(renderInputText(e)),
    });
    return [clip(`${u.dim(r.glyph.promptIdle)} ${e}`, n), ``];
  }
  let style = (e) => {
      let t = renderInputText(e);
      return a && t.length > 0 ? u.blue(t) : t;
    },
    d = layoutPromptInput({ text: e, cursor: t }),
    f = Math.min(Math.max(1, s), d.rows.length),
    p = Math.max(0, Math.min(d.caretRow - f + 1, d.rows.length - f)),
    m = l === !0 ? u.dim(r.glyph.prompt) : u.cyan(r.glyph.prompt),
    h = u.dim(r.glyph.ellipsis),
    g = Math.max(1, n - 3),
    _ = [];
  for (let e = p; e < p + f; e += 1) {
    let t = d.rows[e],
      a = e === 0 ? m : ` `;
    ((e === p && p > 0) || (e === p + f - 1 && p + f < d.rows.length)) &&
      (a = h);
    let s;
    if (e === d.caretRow) {
      let {
        before: e,
        under: n,
        after: a,
      } = visibleLine(
        { text: t.text, cursor: d.caretOffset },
        g,
        r.glyph.ellipsis,
      );
      ((s = renderInputWithBlockCursor({
        before: e,
        under: n,
        after: a,
        visible: i,
        inverse: u.inverse,
        render: style,
      })),
        o.length > 0 && d.rows.length === 1 && (s += o));
    } else s = style(t.text);
    _.push(clip(`${a} ${s}`, n));
  }
  return (_.push(``), _);
}
function previousBlockOf(e) {
  let t = { kind: e.kind };
  return (e.title !== void 0 && (t.title = e.title), t);
}
function isActiveToolStatus(e) {
  return e === `running` || e === `approval`;
}
function applyCohortLiveness(e) {
  let t = e.some((e) => e.active);
  for (let n of e) n.block.live = t || n.active;
}
function leadsWithGap(e, t) {
  if (
    e.kind === `tool` &&
    (t?.kind === `user` || t?.kind === `assistant` || t?.kind === `question`)
  )
    return !0;
  if (e.kind === `sandbox` && t?.kind === `sandbox`) return !1;
  if ((t?.kind === `sandbox` && e.kind !== `sandbox`) || t?.kind === `log`)
    return !0;
  switch (e.kind) {
    case `user`:
    case `assistant`:
    case `reasoning`:
    case `subagent`:
    case `error`:
    case `notice`:
    case `question`:
    case `connection-auth`:
    case `sandbox`:
    case `log`:
    case `command`:
    case `warning`:
    case `flow`:
    case `turn-stats`:
    case `session-boundary`:
    case `todo-list`:
    case `agent-header`:
      return !0;
    default:
      return !1;
  }
}
function parseSandboxLogLine(e) {
  let t = e.trim();
  if (!t.startsWith(`eve: `)) return;
  let n = t.slice(5);
  return /\bsandbox\b/i.test(n) && !isLowValueSandboxLogLine(n) ? n : void 0;
}
function isLowValueSandboxLogLine(e) {
  return (
    /^initializing (?:\d+ )?sandbox templates?\b/i.test(e) ||
    /^initialized \d+ sandbox\b/i.test(e) ||
    /^reused cached sandbox template\b/i.test(e) ||
    /^sandbox template "[^"]+" \([^)]+\): (checking|reusing|loading microsandbox runtime|microsandbox runtime ready)\b/i.test(
      e,
    )
  );
}
function clipLiveRows(e, t, n, r) {
  if (e.length <= t) return [...e];
  if (t <= 1) return [clip(hiddenRowsMarker(e.length, r), n)];
  let i = t - 1;
  return [clip(hiddenRowsMarker(e.length - i, r), n), ...e.slice(e.length - i)];
}
function hiddenRowsMarker(e, t) {
  let n = e.toLocaleString(),
    r = e === 1 ? `row` : `rows`;
  return t.colors.dim(
    `${t.glyph.dot} ${t.glyph.ellipsis} ${n} earlier ${r} hidden while streaming`,
  );
}
function collapseReasoning(e, t) {
  switch (e) {
    case `collapsed`:
      return !0;
    case `auto-collapsed`:
      return !t;
    default:
      return !1;
  }
}
function renderNativeToolBlock(e, t, n, r) {
  let i =
      e.preparing === !0
        ? presentPreparingTool(e.toolName, r)
        : presentTool(e.toolName, e.input, r),
    a = {
      id: t,
      kind: `tool`,
      title: stripTerminalControls(i.title),
      subtitle: stripTerminalControls(i.subtitle),
      status: e.status,
      live: e.status === `running` || e.status === `approval`,
      expanded: n,
      toolInput: e.input,
      toolName: e.toolName,
      toolGroup: i.group,
    };
  return (
    i.doneTitle !== void 0 &&
      (a.doneTitle = stripTerminalControls(i.doneTitle)),
    i.detail !== void 0 &&
      ((a.detailLines = i.detail),
      (a.keepDetailWhenDone = i.keepDetailWhenDone === !0)),
    e.output === void 0
      ? e.errorText !== void 0 &&
        (a.result = stripTerminalControls(e.errorText))
      : ((a.result = i.summarizeResult(e.output)), (a.toolOutput = e.output)),
    a
  );
}
function writeExistedFlag(e) {
  if (typeof e != `object` || !e || Array.isArray(e)) return;
  let t = e.existed;
  return typeof t == `boolean` ? t : void 0;
}
function subagentToolStatus(e) {
  switch (e) {
    case `preparing`:
      return `running`;
    case `approval-requested`:
      return `approval`;
    case `executing`:
      return `running`;
    case `done`:
      return `done`;
    case `failed`:
      return `error`;
    case `rejected`:
      return `denied`;
  }
}
function formatToolApprovalTitle(e) {
  return stripTerminalControls(e.title ?? e.toolName);
}
function toolSectionId(e) {
  return `tool:${e}`;
}
function questionSectionId(e) {
  return `question:${e}`;
}
function subagentHeaderId(e) {
  return `subagent:${e}:header`;
}
function subagentStepSectionId(e, t) {
  return `subagent:${e}:step:${t}`;
}
function subagentToolSectionId(e, t) {
  return `subagent:${e}:tool:${t}`;
}
function connectionAuthSectionId(e) {
  return `connection-auth:${e}`;
}
function connectionAuthTerminalMessage(e) {
  switch (e) {
    case `authorized`:
      return `Authorization complete`;
    case `declined`:
      return `Authorization declined`;
    case `failed`:
      return `Authorization failed`;
    case `timed-out`:
      return `Authorization timed out`;
    case `required`:
    case `pending`:
      return;
  }
}
function formatConnectionAuthContent(e, t) {
  let n = [];
  if (t !== void 0) n.push(t);
  else {
    let t = stripTerminalControls(e.description);
    t.length > 0 && n.push(t);
    let r = e.challenge;
    (r?.url && n.push(`URL: ${stripTerminalControls(r.url)}`),
      r?.userCode && n.push(`Code: ${stripTerminalControls(r.userCode)}`),
      r?.expiresAt && n.push(`Expires: ${stripTerminalControls(r.expiresAt)}`),
      r?.instructions && n.push(stripTerminalControls(r.instructions)));
  }
  if (e.reason !== void 0) {
    let t = stripTerminalControls(e.reason);
    t.length > 0 && n.push(`Reason: ${t}`);
  }
  return n.join(`
`);
}
function formatQuestionContent(e, t, n) {
  let r = n.colors,
    i = [],
    a = e.options ?? [];
  if (a.length > 0) {
    for (let [e, o] of a.entries()) {
      let a = stripTerminalControls(o.label),
        s =
          o.description === void 0 ? `` : stripTerminalControls(o.description),
        c = t === e,
        l = s.length > 0 ? `${c ? ` ` : `  `}${r.dim(`— ${s}`)}` : ``,
        u = renderCursorRow(
          c ? `${n.glyph.selectedPointer} ${a}` : `  ${a}`,
          c,
          r,
        );
      i.push(`${u}${l}`);
    }
    if (e.allowFreeform === !0) {
      let e = t === a.length,
        o = `Type your own answer`,
        s = e ? `${n.glyph.selectedPointer} ${o}` : `  ${r.dim(o)}`;
      i.push(renderCursorRow(s, e, r));
    }
  } else i.push(r.dim(`  (type your answer)`));
  return i.join(`
`);
}
function resolveQuestionText(e, t) {
  let n = e.trim();
  if (n.length === 0) return;
  let r = n.toLowerCase(),
    i = t.options ?? [];
  if (i.length > 0) {
    let e = matchQuestionOption(r, i);
    if (e !== void 0) return { optionId: e.id, label: e.label };
  }
  if (t.allowFreeform === !0 || i.length === 0) return { text: n, label: n };
}
function matchQuestionOption(e, t) {
  let n = t.find((t) => t.id.toLowerCase() === e);
  if (n !== void 0) return n;
  let r = t.find((t) => t.label.toLowerCase() === e);
  if (r !== void 0) return r;
  let i = Number(e);
  if (Number.isInteger(i) && i > 0 && i <= t.length) return t[i - 1];
}
export { TerminalRenderer };
