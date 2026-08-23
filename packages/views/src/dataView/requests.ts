let asked = 0;

/**
 * The next number a request carries, counted across the whole view.
 *
 * Answers are matched to questions by this number, and more than one part of the view asks the
 * same kind of question — the SQL panel and the filter field both ask what the language server
 * makes of some SQL. Counting per component gave them each a request 1, and each accepted the
 * other's answer.
 */
export function nextRequestId(): number {
  asked += 1;
  return asked;
}
