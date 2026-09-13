import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerObjectiveCMessagesClassReceiversAndImportTests(): void {


  describe('Objective-C messages, class receivers, and #import', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('resolves single-arg selectors, class-message receivers, and #import headers', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'SDImageCache.h'),
        `#import <Foundation/Foundation.h>
@interface SDImageCache : NSObject
+ (instancetype)sharedCache;
+ (void)storeImage:(NSString *)key;
@end
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'SDImageCache.m'),
        `#import "SDImageCache.h"
@implementation SDImageCache
+ (instancetype)sharedCache { return nil; }
+ (void)storeImage:(NSString *)key { }
@end
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'SDManager.m'),
        `#import "SDImageCache.h"
@interface SDManager : NSObject
@end
@implementation SDManager
- (void)run {
  [SDImageCache sharedCache];
  [SDImageCache storeImage:@"k"];
}
@end
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // 1. The single-argument selector `[SDImageCache storeImage:@"k"]` resolves
      //    to the `storeImage:` method — named WITH its colon both at the call site
      //    and the definition (before the fix the call site dropped the colon).
      const storeImage = cg.getNodesByKind('method').find((n) => n.name === 'storeImage:');
      expect(storeImage, 'storeImage: method').toBeDefined();
      const storeCallers = [...cg.getImpactRadius(storeImage!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(storeCallers.some((p) => p.endsWith('SDManager.m'))).toBe(true);

      // 2. The class-message receiver `[SDImageCache sharedCache]` references the
      //    SDImageCache class (whose @interface lives in the header).
      const cache = cg.getNodesByKind('class').find((n) => n.name === 'SDImageCache');
      expect(cache, 'SDImageCache class').toBeDefined();
      const classDeps = [...cg.getImpactRadius(cache!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(classDeps.some((p) => p.endsWith('SDManager.m'))).toBe(true);

      // 3. `#import "SDImageCache.h"` resolves to the header FILE — editing it
      //    surfaces both importers.
      const header = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('SDImageCache.h'));
      expect(header, 'SDImageCache.h indexed').toBeDefined();
      const importers = [...cg.getImpactRadius(header!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(importers.some((p) => p.endsWith('SDManager.m'))).toBe(true);
    });
  });
}
