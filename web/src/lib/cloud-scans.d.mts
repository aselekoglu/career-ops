export function workerConfigured(env?: NodeJS.ProcessEnv): boolean;
export function workerAuthorized(value: string | null, env?: NodeJS.ProcessEnv): boolean;
export function handleScanRequest(request: Request, id?: string | null): Promise<Response>;
export function handleScanWorker(request: Request): Promise<Response>;
