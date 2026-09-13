export interface ProductMetadata {
  readonly displayName: string;
  readonly version: string;
  readonly buildNumber: string;
  readonly internalName: string;
  readonly bundleId: string;
  readonly dataDirectory: string;
  readonly publisher: string;
}

declare const __CHESHI_PRODUCT__: ProductMetadata;

export const product = Object.freeze(__CHESHI_PRODUCT__);
