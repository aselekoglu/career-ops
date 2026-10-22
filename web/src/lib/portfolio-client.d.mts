export class PortfolioClientError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message?: string);
}
export function createPortfolioOperationKeys(makeId?: () => string): {
  begin(slot: string, payload: unknown): string;
  complete(slot: string, operationId: string): void;
  clear(slot: string): void;
};
export function portfolioRunMode(sourceMode: "profile" | "portfolio"): "generate" | "edit";
export function portfolioErrorMessage(code: string, status: number): string;
export function portfolioRequest<T = unknown>(route: string, init?: RequestInit): Promise<T>;
