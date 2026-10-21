export async function resolvePortalVerification({
  cloud,
  databaseConfigured,
  unavailableMessage = 'Cloud portal verification is disabled without Neon.',
  cloudVerify,
  localVerify,
}) {
  if (databaseConfigured) {
    return { status: 200, body: await cloudVerify() };
  }
  if (cloud) {
    return {
      status: 501,
      body: {
        error: unavailableMessage,
        code: 'CLOUD_EXECUTION_DISABLED',
        available: false,
        configured: false,
        companies: [],
        cloud: true,
        readOnly: true,
        note: 'Hosted portal snapshot is unavailable without Neon; live ATS checks remain disabled.',
      },
    };
  }
  return { status: 200, body: await localVerify() };
}
