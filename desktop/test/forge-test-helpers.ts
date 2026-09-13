import createForgeConfiguration from '../../forge.config.mts';

interface ForgeTestConfiguration {
  readonly packagerConfig: {
    readonly ignore?: unknown;
  };
}

export function loadForgeConfiguration(): Promise<ForgeTestConfiguration> {
  return createForgeConfiguration() as Promise<ForgeTestConfiguration>;
}
