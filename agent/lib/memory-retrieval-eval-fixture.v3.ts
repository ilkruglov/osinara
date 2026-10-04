/**
 * Long discussion summaries for long-term memory retrieval evaluation.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_EVAL_RECORDS_V3`: synthetic multi-paragraph summaries, each holding
 *   several unrelated theses, so a query must find a thesis deep inside a long record.
 * - `MEMORY_RETRIEVAL_EVAL_QUERIES_V3`: one query per buried thesis, two abstention queries.
 * - `MEMORY_RETRIEVAL_V3_GATES`: the floor measured before chunking changed.
 *
 * Key construct:
 * - Production keeps summaries of three to four thousand characters (attribute «итог
 *   обсуждения», up to twelve chunks each) next to one-sentence facts; the v1/v2 fixtures hold
 *   records of at most 83 characters, so chunking never affected them. These records are seeded
 *   through the chunker, so the eval measures chunk boundaries as well as ranking.
 */
import type {
  MemoryRetrievalEvalQuery,
  MemoryRetrievalEvalRecord,
} from "./memory-retrieval-eval-fixture.v1.js";

export const MEMORY_RETRIEVAL_EVAL_RECORDS_V3: readonly MemoryRetrievalEvalRecord[] = [
  {
    content: [
      "Итог обсуждения 12.09.2026 в семейном чате о планах на осень.",
      "Марина предложила отремонтировать балкон до холодов: заменить остекление на тёплое и утеплить пол. Сергей согласился, но попросил сначала получить две сметы, потому что прошлой осенью мастер завысил цену вдвое после начала работ. Решили: Марина запрашивает сметы у двух фирм до 20 сентября, выбирают ту, где гарантия не меньше трёх лет.",
      "Отдельно спорили о школе Лизы: учительница математики предложила перевести её в профильный класс со следующей четверти. Лиза сомневается из-за новых одноклассников, Сергей — за, Марина просит не давить. Договорились сходить на открытый урок 25 сентября всей семьёй и решить после него.",
      "По машине: у старого Опеля опять загорелась лампа давления масла, Сергей заезжал в сервис на Профсоюзной, там сказали, что датчик, а не насос, замена стоит около четырёх тысяч. Записались на вторник. Марина напомнила, что страховка заканчивается 3 октября, продлевать будут в той же компании, где скидка за безаварийность.",
      "Про бабушку Валентину: она жалуется на давление по утрам, терапевт поменял таблетки на лозартан, принимать в восемь утра, а не вечером. Марина будет звонить ей каждый день в девять и спрашивать про самочувствие. Сергей купит тонометр с большими цифрами, бабушка плохо видит мелкий экран.",
      "В конце договорились про поездку на ноябрьские: едут в Суздаль на три дня, гостиница «Пушкарская слобода» уже забронирована на 2–4 ноября, с собой берут собаку, поэтому нужна машина, а не поезд.",
    ].join("\n\n"),
    key: "autumn-summary",
    updatedAt: "2026-09-12T20:00:00.000Z",
  },
  {
    content: [
      "Итог обсуждения 28.08.2026 о ремонте кухни и бюджете.",
      "Смета на кухню от «Кухонного двора» — 640 тысяч с техникой, от «Марии» — 710, но у «Марии» фасады из МДФ с эмалью, а не из плёнки. Марина за «Марию», Сергей просит уложиться в 650, иначе придётся брать рассрочку. Решили: просят у «Марии» скидку за самовывоз техники и отказ от подсветки, если дадут 660 — берут.",
      "Про посудомойку: встраиваемая Bosch на 45 см, узкая, потому что между холодильником и стеной всего 48 см. Сергей замерял дважды, Марина просит мастера перемерить до заказа фасадов.",
      "Кот Барсик снова царапает дверь в спальню по ночам. Ветеринар сказал, что это скука, а не болезнь: нужна когтеточка у двери и игрушка с кормом. Лиза купит когтеточку на Озоне, Сергей повесит её в субботу.",
      "Деньги: с сентября откладывают по пятнадцать тысяч на отпуск на отдельный счёт в Тинькофф, доступ у обоих. Крупные покупки больше ста тысяч обсуждают вместе заранее, это новое правило после истории с велосипедом.",
      "Соседи сверху затопили ванную второй раз за год, акт из ЖЭКа есть, ущерб оценили в тридцать две тысячи. Если до 15 сентября не заплатят добровольно — Сергей подаёт в мировой суд, образец иска ему уже скинул Паша.",
    ].join("\n\n"),
    key: "kitchen-summary",
    updatedAt: "2026-08-28T20:00:00.000Z",
  },
  {
    content: [
      "Итог обсуждения 05.09.2026 о здоровье и спорте.",
      "Лиза хочет записаться в секцию плавания в бассейн на Ленинском, занятия по вторникам и четвергам в семь вечера, абонемент на три месяца стоит двенадцать тысяч. Марина согласна при условии, что Лиза сама будет ездить на автобусе 57, он идёт прямо от школы.",
      "Сергею нужно пройти диспансеризацию до конца сентября, запись через Госуслуги, участковая в поликлинике №4, кабинет 212. Марина записала его на 19 сентября на 8:30, натощак, с собой паспорт и полис.",
      "Про аллергию Лизы: весной была реакция на цветение берёзы, аллерголог рекомендовал начать курс таблеток в феврале, за два месяца до сезона, и завести дома очиститель воздуха. Марина посмотрит модели с HEPA-фильтром до Нового года.",
      "Сергей бросил курить третью неделю, держится на никотиновых пластырях, просит не напоминать и не хвалить лишний раз — его это раздражает. Марина убрала пепельницу с балкона.",
    ].join("\n\n"),
    key: "health-summary",
    updatedAt: "2026-09-05T20:00:00.000Z",
  },
  // Production summaries have no paragraph breaks: theses follow each other in one paragraph,
  // separated by sentence ends, semicolons and dashes; these two mirror that shape.
  {
    content: "Итог обсуждения 19.09.2026 в чате дачи. Обсуждали воду: насос в колодце стал качать с перебоями, Сергей думает, что обратный клапан, Дима — что сам насос, решили вызвать мастера Виталия с Садовой в субботу; он берёт две тысячи за выезд. Дальше про забор: соседка Нина Петровна согласна на общий забор из профнастила, делим пополам, цена по смете шестьдесят тысяч, она платит свою половину в октябре после пенсии. Про урожай — яблоки в этом году некуда девать, Марина отвезёт три ящика в приют на Тверской в понедельник, остальное на сок к Диме в соковыжималку. Печь: трубу надо чистить до первых морозов, Сергей купит ёрш, чистить будут вдвоём с Димой, в прошлый раз Сергей чуть не упал с крыши, поэтому страховочный пояс обязателен. В конце договорились, что на зиму воду сливают 2 ноября и больше в этом году на дачу не ездят.",
    key: "dacha-summary",
    updatedAt: "2026-09-19T20:00:00.000Z",
  },
  {
    content: "Итог обсуждения 02.09.2026 о школе и кружках. Лиза идёт в седьмой класс, классная теперь Ольга Викторовна, родительский чат переехал в Max, Марина там, Сергея ещё не добавили — попросить Ольгу Викторовну. Форма: школа требует тёмно-синий низ и белый верх, старые брюки малы, купить до 10 сентября в «Детском мире» на Калужской, там скидка по карте. Английский: репетитор Анна Сергеевна подняла цену до двух тысяч за час, занятия по средам в 17:00 онлайн, Лиза хочет оставить, Сергей согласен при условии, что оценка за четверть будет не ниже четвёрки. Робототехника в Кванториуме по субботам в 11:00 бесплатная, запись через Госуслуги до 15 сентября, Марина записала. Про телефон — Лиза просит новый, старый держит заряд три часа; решили, что меняют батарею за три тысячи, а новый телефон только к дню рождения в декабре, если четверть без троек.",
    key: "school-summary",
    updatedAt: "2026-09-02T20:00:00.000Z",
  },
] as const;

export const MEMORY_RETRIEVAL_EVAL_QUERIES_V3: readonly MemoryRetrievalEvalQuery[] = [
  {
    category: "semantic_paraphrase",
    expectedKeys: ["autumn-summary"],
    key: "buried-grandmother-pills",
    text: "Какие таблетки от давления пьёт бабушка и когда?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["autumn-summary"],
    key: "buried-suzdal-trip",
    text: "Куда едем на ноябрьские праздники и где остановимся?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["autumn-summary"],
    key: "buried-car-sensor",
    text: "Что сказали в сервисе про лампу масла на Опеле?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["kitchen-summary"],
    key: "buried-cat-scratching",
    text: "Почему Барсик царапает дверь и что с этим делать?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["kitchen-summary"],
    key: "buried-neighbours-flood",
    text: "Сколько соседи должны за затопленную ванную и до какого числа?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["kitchen-summary"],
    key: "buried-savings-rule",
    text: "Какое у нас правило про крупные покупки?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["health-summary"],
    key: "buried-dispensary",
    text: "Когда у Сергея диспансеризация и что взять с собой?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["health-summary"],
    key: "buried-quit-smoking",
    text: "Как Сергей переносит отказ от курения?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["dacha-summary"],
    key: "buried-chimney-safety",
    text: "Что нужно для чистки трубы печи на даче?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["dacha-summary"],
    key: "buried-fence-share",
    text: "Сколько соседка платит за забор и когда?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["school-summary"],
    key: "buried-tutor-price",
    text: "Сколько теперь стоит час с репетитором по английскому?",
  },
  {
    category: "semantic_paraphrase",
    expectedKeys: ["school-summary"],
    key: "buried-phone-battery",
    text: "Что решили с телефоном Лизы?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "negative-dentist",
    text: "Когда запись к стоматологу у Лизы?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "negative-dacha-sale",
    text: "За сколько решили продавать дачу?",
  },
] as const;

/**
 * Measured on 5 October 2026 with one chunk per paragraph under a thousand characters (and with
 * the fixed 400-character windows before it): every buried thesis is found at the top. The
 * abstention queries are near misses by design (a dacha question against a dacha summary) and
 * carry no floor; they are printed for the record.
 */
export const MEMORY_RETRIEVAL_V3_GATES = {
  buriedThesisRecallAt5Minimum: 1,
  negativeEmptyRateMinimum: 0,
} as const;
