// Thrown by the lookup hooks when a request was superseded (a newer request
// or a reset started while it was in flight). Its result or error is
// dropped without touching state; callers stop quietly on it.
export class StaleRequestError extends Error {
  constructor() {
    super("Superseded by a newer request");
    this.name = "StaleRequestError";
  }
}
