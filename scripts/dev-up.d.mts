export interface DevUpConfiguration {
  readonly lanHosts: readonly string[];
  readonly webBindHosts: readonly string[];
  readonly webPort: number;
  readonly controlPlaneBindHost: '127.0.0.1';
  readonly controlPlanePort: number;
  readonly allowedWebOrigins: readonly string[];
  readonly publicUrls: readonly string[];
}

export function parseLanHosts(addressOutput: string): string[];

export function readConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  lanHosts?: readonly string[],
): DevUpConfiguration;
