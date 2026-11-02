export const PORTFOLIO_DOCUMENT_SCHEMA_VERSION: 'careerops.portfolio.document@1';
export const MAX_PORTFOLIO_DOCUMENT_BYTES: number;
export const MAX_PORTFOLIO_PROJECTS: number;
export const MAX_PORTFOLIO_RENDERED_PAGES: 12;
export type PortfolioDocument = {
  schemaVersion: 'careerops.portfolio.document@1'; name: string; headline: string; summary: string;
  highlights: string[]; projects: Array<{title:string;role:string;summary:string;highlights:string[];skills:string[];links:Array<{label:string;url:string}>}>;
  skills: string[]; links: Array<{label:string;url:string}>; theme?: 'classic'|'editorial';
};
export class PortfolioDocumentError extends Error { constructor(code: string); }
export function normalizePortfolioDocument(value: unknown): PortfolioDocument;
export function renderPortfolioDocument(document: PortfolioDocument|unknown, options?: {format?:'letter'|'a4'}): string;
