// The error type for "you asked for something that can't be done" (bad flags, no AddOns
// folder, game running): main.js prints it without a stack and exits with code 2.
export class UsageError extends Error {}
