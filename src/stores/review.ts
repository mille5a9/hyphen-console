// One review, the same shape whichever store it came from.
export interface Review {
  store: "apple" | "google";
  appId: string;
  /** The store's own id for the review. */
  id: string;
  rating: number;
  title: string;
  body: string;
  author: string;
  /** Apple: territory code (USA). Google: reviewer language (en_US). */
  locale: string;
  appVersion: string;
  device: string;
  /** Epoch ms the review was written or last edited. */
  updatedAt: number;
  reply: { text: string; at: number } | null;
}

export class StoreApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
