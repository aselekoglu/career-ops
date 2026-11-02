export type PortalVerificationResult = {
  status: number;
  body: unknown;
};

export function resolvePortalVerification(options: {
  cloud: boolean;
  databaseConfigured: boolean;
  unavailableMessage?: string;
  cloudVerify: () => unknown | Promise<unknown>;
  localVerify: () => unknown | Promise<unknown>;
}): Promise<PortalVerificationResult>;
