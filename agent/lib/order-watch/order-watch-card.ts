/**
 * The live card of a watched taxi or Lavka order: one Telegram widget that redraws as the order moves.
 *
 * Exports:
 * - `orderCardData`: the card's state from a look at the order, a short JSON for `chat_data`.
 * - `orderCardKey`: the same without the time of the look, to tell whether the card must change.
 * - `orderCardHtml`: the card itself, with the first state inside.
 *
 * Key constructs:
 * - A widget's HTML cannot change after sending; only its state can (`editMessageWidgetData`,
 *   1024 bytes, silent). The card knows every stage of the order and draws the one in its state, so
 *   one message follows the whole order instead of a message per step.
 * - The state holds only what the site returned for the person's own order (status, car, plates,
 *   driver, minutes, cost, the shop's own lines), clipped by characters and then fitted to 1024 UTF-8
 *   bytes of JSON, control characters dropped; no address, no model text. The time of the look goes
 *   in as seconds and is shown in the viewer's own clock.
 * - The first state is written into the HTML, so the card shows the order before any edit; text from
 *   the site enters the page only through `textContent`, and `<` is escaped inside the script.
 */
import type { OrderObservation } from "./order-watch-dispatcher.js";

// Control and format characters carry nothing to read and grow six-fold in JSON (`\u0001`).
const clip = (value: string | null | undefined, max: number): string | null => {
  const flat = (value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return flat ? Array.from(flat).slice(0, max).join("") : null;
};

// Telegram's limit for `chat_data`, in UTF-8 bytes of the JSON; the time of the look is added last.
const CHAT_DATA_MAX_BYTES = 1_024;
const TIME_FIELD_BYTES = 20;

function orderCardFields(observation: OrderObservation): Record<string, unknown> {
  if (observation.service === "yandex_taxi") {
    const taxi = observation.taxi;
    return {
      c: clip(taxi.car, 60), d: clip(taxi.driver, 40), ...(taxi.finalCost ? { f: clip(taxi.finalCost, 30) } : {}),
      k: "taxi", m: taxi.minutesLeft, p: clip(taxi.plates, 20), s: clip(taxi.status, 30),
    };
  }
  const lavka = observation.lavka;
  return lavka === null
    ? { k: "lavka", s: "gone" }
    : { k: "lavka", s: clip(lavka.status, 30), su: clip(lavka.subtitle, 160), ti: clip(lavka.title, 120) };
}

/** What the card shows, without the time of the look: the card is edited only when this changes. */
export function orderCardKey(observation: OrderObservation): string {
  return JSON.stringify(fittedFields(observation));
}

/** The fields within the byte limit: the shop's long lines are shortened first, the subtitle before the title. */
function fittedFields(observation: OrderObservation): Record<string, unknown> {
  const fields = orderCardFields(observation);
  const fits = () => Buffer.byteLength(JSON.stringify(fields)) + TIME_FIELD_BYTES <= CHAT_DATA_MAX_BYTES;
  for (const name of ["su", "ti", "s"] as const) {
    while (!fits() && typeof fields[name] === "string" && (fields[name] as string).length > 0) {
      const characters = Array.from(fields[name] as string);
      fields[name] = characters.slice(0, Math.floor(characters.length / 2)).join("") || null;
    }
  }
  return fields;
}

export function orderCardData(observation: OrderObservation, at: Date): string {
  return JSON.stringify({ ...fittedFields(observation), t: Math.floor(at.getTime() / 1_000) });
}

const STYLE = `<style>
.w{font:14px/1.4 system-ui,sans-serif;color:var(--tg-theme-text-color,#111);padding:10px 12px}
.h{display:flex;justify-content:space-between;align-items:baseline}
.n{font-weight:600;font-size:16px}.u{color:var(--tg-theme-hint-color,#888);font-size:12px}
.s{font-size:17px;font-weight:600;margin:6px 0 2px}.s.ok{color:#2e9b57}.s.bad{color:#d64541}
.x{color:var(--tg-theme-hint-color,#888)}
.st{display:flex;gap:4px;margin-top:10px}.st i{flex:1;height:5px;border-radius:3px;background:var(--tg-theme-secondary-bg-color,#e5e5e5)}
.st i.on{background:var(--tg-theme-button-color,#2a7ae2)}
</style>`;

// Stage index per status, the label of the stage and the statuses that end the order.
const TAXI = `{st:{search:0,scheduling:0,draft:0,scheduled:0,preexpired:0,driving:1,waiting:2,calling:2,transporting:3,complete:4},
lb:["Ищем машину","Машина едет","Машина на месте","В пути","Поездка завершена"],
end:{cancelled:"Заказ отменён",expired:"Машину не нашли",failed:"Заказ не выполнен"},title:"Такси"}`;
const LAVKA = `{st:{created:0,pending:0,assembling:1,assembled:2,performer_found:3,delivering:4,delivery_arrived:5,closed:6},
lb:["Заказ принят","Собираем","Собран","Курьер назначен","Курьер в пути","Курьер на месте","Доставлен"],
end:{canceled:"Заказ отменён",gone:"Заказ закрыт"},title:"Лавка"}`;

export function orderCardHtml(service: OrderObservation["service"], firstData: string): string {
  const first = firstData.replace(/</gu, "\\u003c");
  return `${STYLE}
<div class="w"><div class="h"><span class="n" id="n"></span><span class="u" id="u"></span></div>
<div class="s" id="s"></div><div class="x" id="x"></div><div class="st" id="st"></div></div>
<script>
var K=${service === "yandex_taxi" ? TAXI : LAVKA};
var first=${first};
function el(id){return document.getElementById(id);}
function draw(raw){
  var d=first;
  try{if(raw)d=JSON.parse(raw);}catch(e){}
  var stage=K.st[d.s],end=K.end[d.s],last=K.lb.length-1;
  el("n").textContent=K.title;
  el("u").textContent=d.t?"обновлено "+new Date(d.t*1000).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}):"";
  var s=el("s");
  s.textContent=end||(stage===undefined?(d.ti||"Статус: "+d.s):K.lb[stage]);
  s.className="s"+(end?" bad":stage===last?" ok":"");
  var x=[];
  if(d.k==="taxi"){if(d.c)x.push(d.c);if(d.p)x.push(d.p);if(d.d)x.push(d.d);if(d.m!==null&&d.m!==undefined&&stage===1)x.push("через "+d.m+" мин");if(d.f)x.push(d.f);}
  else{if(d.ti&&stage!==undefined)x.push(d.ti);if(d.su)x.push(d.su);}
  el("x").textContent=x.join(" · ");
  var st=el("st");st.textContent="";
  for(var i=0;i<=last;i++){var b=document.createElement("i");if(!end&&stage!==undefined&&i<=stage)b.className="on";st.appendChild(b);}
}
draw(window.TelegramWidget&&TelegramWidget.chatData);
if(window.TelegramWidget){TelegramWidget.onEvent("chatDataChanged",function(){draw(TelegramWidget.chatData);});TelegramWidget.ready();}
</script>`;
}
