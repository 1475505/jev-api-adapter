import type { Decision } from "./types.ts";

// Version names when changing decision semantics; no hidden LLM compilation.
export const PRESETS: Record<string, Decision["questions"]> = {
  "sentiment-v1": {
    sentiment: {
      type: "choice", instructions: "Classify the sentiment expressed in the text.",
      criteria: { positive: "Positive sentiment", neutral: "Neutral or mixed sentiment", negative: "Negative sentiment" },
    },
  },
  "ticket-routing-v1": {
    department: {
      type: "choice", instructions: "Which department should handle this support request?",
      criteria: { billing: "Payments, refunds and invoices", technical: "Technical failures and bugs", other: "Other requests" },
    },
    urgent: { type: "noul", instructions: "Does the customer express urgency?" },
  },
};
