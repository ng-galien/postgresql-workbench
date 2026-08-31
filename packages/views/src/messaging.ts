/** Host-neutral request/response port received by every standalone React view. */
export interface ViewMessaging<Request, Response> {
  post(message: Request): void;
  subscribe(listener: (message: Response) => void): () => void;
}
