export const SESSION_PROMPT_IMAGE = 1;
export const SESSION_PROMPT_STEERING = 2;

/** Derive session-scoped prompt flags directly from the ACP state extension. */
export function sessionPromptCapabilityBits(
  state: { imageSupported?: boolean; steeringSupported?: boolean } | null | undefined,
): number {
  return (state?.imageSupported === true ? SESSION_PROMPT_IMAGE : 0)
    | (state?.steeringSupported === true ? SESSION_PROMPT_STEERING : 0);
}
