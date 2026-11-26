// The "+" after the tabs (#3453): the `tab.new` arguments of a new Gentle Shell session. Pure (no
// host calls): main.js passes the shown space and the shown session's project;
// tests/gentle-shell-desktop.test.ts imports it. The session starts in the project's folder, and in
// the space's own folder only when no project is known: a space's stored folder can be another
// project's, and Herdr cannot change it after creation.
export function newTabArgs(space, project) {
  const folder = project || space?.folder;
  return { argv: ["gentle-shell"], ...(space?.id ? { space: space.id } : {}), ...(folder ? { folder } : {}) };
}
