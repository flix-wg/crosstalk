// node:sqlite emits through Node's native warning path, not process.emitWarning.
// Preserve other warnings and their installed handlers.
for (const listener of process.listeners("warning")) {
  process.removeListener("warning", listener);
  process.on("warning", warning => {
    if (warning.name === "ExperimentalWarning" && warning.message.startsWith("SQLite is an experimental feature")) return;
    listener.call(process, warning);
  });
}
