/** An import failure whose message is written for the user. */
export class ImportError extends Error {}

/** AI read the content and found no recipe in it. */
export class NoRecipeFoundError extends ImportError {}
