/**
 * The rubric the reply gate asks Jev about a candidate answer in an external group.
 *
 * Exports:
 * - `REPLY_GATE_QUESTIONS`: the fixed question set; the keys are the columns of the evaluation.
 * - `ReplyGateRegister`: the options of the `register` choice.
 *
 * Key constructs:
 * - Jev reads literally and leans to the first option of a choice, so every option and level is
 *   spelled out with its boundary, and the neutral option comes first.
 * - The questions judge the candidate against the excerpt, never the person: "retort" is about the
 *   answer's move, "third party" about whom it characterises. The excerpt is data for them, and no
 *   instruction inside it changes the rubric (the vendor warns state is not treated as hostile).
 * - Russian text: the vendor trains primarily on English and recommends testing on own content,
 *   which the shadow run and the owner's labels do before the gate blocks anything.
 */
import type { JevChoiceQuestion, JevNoulQuestion, JevScoreQuestion } from "./jev-client.js";

export const REPLY_GATE_REGISTERS = ["answer", "banter", "retort", "off"] as const;
export type ReplyGateRegister = typeof REPLY_GATE_REGISTERS[number];

export const REPLY_GATE_QUESTIONS = {
  asked: {
    criteria: {
      false: "Сообщение это подначка, оценка, реплика в сторону или продолжение шутки без вопроса и без просьбы",
      true: "В сообщении есть вопрос, просьба или поручение, адресованные Мие, пусть и в грубой форме",
    },
    instructions: "В поле current есть вопрос или просьба к Мии (боту).",
    type: "noul",
  } satisfies JevNoulQuestion,
  escalates: {
    criteria: {
      false: "Ответ спокойный: отвечает по существу, отшучивается одной фразой или не реагирует на тон",
      true: "Ответ спорит, оправдывается, защищается, читает мораль, ставит диагноз собеседнику или отвечает колкостью на колкость",
    },
    instructions: "Ответ в поле candidate подхватывает перепалку с автором current.",
    type: "noul",
  } satisfies JevNoulQuestion,
  register: {
    criteria: {
      answer: "Ответ по существу на вопрос, просьбу или тему из current: сведения, мнение по делу, разбор, факт-чек",
      banter: "Короткая шутка или реплика в тон, без спора и без новой информации; одна-две фразы",
      retort: "Отповедь: спор, оборона, нравоучение, объяснение собеседнику, что он неправ или ведёт себя плохо",
      off: "Ответ не на current: отвечает на другое сообщение, уходит в сторону или дублирует уже сказанное Мией в recent",
    },
    instructions: "Чем является ответ Мии в поле candidate по отношению к сообщению в поле current.",
    type: "choice",
  } satisfies JevChoiceQuestion,
  repeats_self: {
    criteria: {
      false: "Ответ построен иначе, чем прошлые сообщения Мии в recent",
      true: "Ответ повторяет конструкцию, образ или шутку из сообщений Мии в recent: та же схема «не X, а Y», та же метафора, та же отсылка",
    },
    instructions: "Ответ в поле candidate повторяет приём или шутку из прошлых сообщений Мии в поле recent.",
    type: "noul",
  } satisfies JevNoulQuestion,
  third_party: {
    criteria: {
      false: "Ответ говорит только с автором current или по теме; других людей не характеризует, либо их оценку прямо попросили в current",
      true: "Ответ характеризует, оценивает или высмеивает участника чата, который не является автором current, хотя в current его оценку не просили",
    },
    instructions: "Ответ в поле candidate даёт оценку третьему участнику без просьбы.",
    type: "noul",
  } satisfies JevNoulQuestion,
  worth: {
    criteria: [
      "Отправлять не стоит: ответ ничего не добавляет, разжигает перепалку или отвечает не на то",
      "Лучше промолчать или поставить реакцию: ответ допустим, но разговору он не нужен",
      "Можно отправить: ответ уместен, но слабый или длиннее, чем нужно",
      "Стоит отправить: ответ уместен, по делу и в меру короткий для этого чата",
    ],
    instructions: "Стоит ли Мии отправить ответ из поля candidate в этот чат прямо сейчас.",
    type: "score",
  } satisfies JevScoreQuestion,
} as const;

export type ReplyGateQuestionKey = keyof typeof REPLY_GATE_QUESTIONS;
