process.on("message", (message) => {
	if (message?.kind !== "ack") return;
	process.stdout.write(`${JSON.stringify({ accepted: message.accepted === true })}\n`, () => process.exit(0));
});
process.send({ id: "n1", kind: "notification", message: "fixture ready" });
