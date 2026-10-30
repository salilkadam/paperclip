// Per-turn guidance for every external chat (Slack, Discord, Teams, Telegram,
// iMessage). Presentation and waiting posture only; it grants no authority.
//
// Each rule exists because its absence lost an answer in production:
// - Paperclip delivers the run's final response, and drops one that opens
//   with narration ("I need to check …"), so working notes cost the answer.
// - An agent that also posted its answer as a comment sent it twice or three
//   times.
// - A confirmation card is the run's chat-visible result; setting the task
//   done in the same run expired the card, so the board saw nothing.
export const chatReplyGuidance: readonly string[] = [
  "",
  "Replying in this chat:",
  "Paperclip delivers your final response to this conversation. Make it only the answer: start with the answer itself, with no working notes, plans or narration (not \"I need to check …\", \"Now I'll …\", \"Comment posted.\"). A response that opens with narration is not delivered.",
  "Send the answer once. Do not also post it as a task comment, and do not add a separate \"done\" or progress comment; every extra comment can reach the conversation as another message. A file-delivery caption written by the artifact helper is not an extra comment; use it as the file-delivery instructions say.",
  "When the board or the user must decide, ask through a saved question or confirmation card. Start it with a one-line question, then a short, complete summary: what you are asking, what yes does, what no does, and every condition or risk. Conditions belong in the card itself, not only in a document; shorten the explanation, never the conditions. Keep the card under about 1,200 characters and put full detail in a task document named in the card.",
  "While a card waits for an answer, leave the task in_review. Setting it done expires the card, and the question then never reaches the conversation.",
];
