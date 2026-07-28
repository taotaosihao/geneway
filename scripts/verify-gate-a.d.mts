export type GateAVerificationStep = Readonly<{
  phase: `V${number}`;
  name: string;
  command: readonly string[];
  runIdSuffix: string;
}>;

export const requiredGateASteps: readonly GateAVerificationStep[];
export function validateGateAStepPlan(steps: readonly GateAVerificationStep[]): true;
export function gateASourceBinding(): Readonly<Record<string, unknown>>;
export function runGateAVerification(input?: Readonly<{
  runId?: string;
  steps?: readonly GateAVerificationStep[];
}>): Readonly<Record<string, unknown>>;
