export const StoryStatus = {
  TODO: "todo",
  DOING: "doing",
  DONE: "done",
  CANCELED: "canceled",
} as const;

export type StoryStatus = (typeof StoryStatus)[keyof typeof StoryStatus];
