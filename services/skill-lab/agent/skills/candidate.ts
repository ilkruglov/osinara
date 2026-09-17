import { defineDynamic, defineSkill } from "eve/skills";
import { job } from "../lib/job.js";
export default defineDynamic({ events: { "session.started": () => {
  const skill = job().skill;
  return skill ? { [skill.name]: defineSkill({ description: skill.description, markdown: skill.markdown, files: skill.files }) } : {};
} } });
