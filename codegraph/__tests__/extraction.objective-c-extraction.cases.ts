import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerObjectiveCExtractionTests(): void {


  // =============================================================================
  // Objective-C
  // =============================================================================

  describe('Objective-C Extraction', () => {
    const sample = `
#import <Foundation/Foundation.h>
#import "MyClass.h"

@interface MyClass : NSObject <NSCopying>
@property (nonatomic, copy) NSString *name;
- (void)greet;
- (void)doThing:(id)x with:(id)y;
+ (instancetype)shared;
@end

@implementation MyClass

- (void)greet {
    NSLog(@"Hello");
    [self doWork];
}

- (void)doThing:(id)x with:(id)y {
    [self notify:x];
}

+ (instancetype)shared {
    return [[MyClass alloc] init];
}

@end

void helperFunction(int count) {
    MyClass *obj = [MyClass shared];
    [obj greet];
}
`;

    it('should extract classes, methods, functions, and imports', () => {
      const result = extractFromSource('App.m', sample);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.filter((c) => c.name === 'MyClass')).toHaveLength(1);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.map((m) => m.name).sort()).toEqual(['doThing:with:', 'greet', 'shared']);

      const shared = methods.find((m) => m.name === 'shared');
      expect(shared?.isStatic).toBe(true);

      const properties = result.nodes.filter((n) => n.kind === 'property');
      expect(properties.some((p) => p.name === 'name')).toBe(true);

      const functions = result.nodes.filter((n) => n.kind === 'function');
      expect(functions.some((f) => f.name === 'helperFunction')).toBe(true);

      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('Foundation/Foundation.h');
      expect(imports).toContain('MyClass.h');
    });

    it('should record inheritance and protocol conformance', () => {
      const result = extractFromSource('App.m', sample);
      const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
      const implementsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'implements');
      expect(extendsRefs.map((r) => r.referenceName)).toContain('NSObject');
      expect(implementsRefs.map((r) => r.referenceName)).toContain('NSCopying');
    });

    it('should record message sends and C calls', () => {
      const result = extractFromSource('App.m', sample);
      const calls = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(calls).toEqual(expect.arrayContaining(['NSLog', 'doWork', 'MyClass.shared', 'obj.greet']));
    });

    it('should reconstruct multi-keyword selectors at the call site so they resolve to the method definition', () => {
      // Regression for the gap discovered post-#165: message_expression's
      // multi-keyword form `[obj a:1 b:2]` was only emitting the first keyword,
      // so calls never resolved to multi-part method definitions like
      // `GET:parameters:headers:progress:success:failure:`. The call-site name
      // must match the method-definition name with full keywords + trailing colons.
      const code = `
@implementation Caller
- (void)demo {
    NSMutableDictionary *d = [NSMutableDictionary new];
    [d setObject:@"v" forKey:@"k"];
    [d setObject:@"v2" forKey:@"k2" withRetry:@YES];
    [self touchesBegan:nil withEvent:nil];
}
@end
`;
      const result = extractFromSource('Caller.m', code);
      const calls = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(calls).toEqual(
        expect.arrayContaining([
          'd.setObject:forKey:',
          'd.setObject:forKey:withRetry:',
          'touchesBegan:withEvent:',
        ])
      );
    });

    it('should not classify pure C headers with @end in comments as objc', () => {
      const cHeader = '/* @end of file */\n#ifndef STDIO_H\nvoid printf(const char *);\n#endif\n';
      expect(detectLanguage('stdio.h', cHeader)).toBe('c');
    });

    it('should extract protocol declarations', () => {
      const code = `
@protocol DataSource <NSObject>
- (NSInteger)numberOfItems;
@end
`;
      const result = extractFromSource('DataSource.h', code);
      const protocol = result.nodes.find((n) => n.kind === 'protocol' && n.name === 'DataSource');
      expect(protocol).toBeDefined();
    });

    it('should report Objective-C as supported', () => {
      expect(isLanguageSupported('objc')).toBe(true);
      expect(getSupportedLanguages()).toContain('objc');
    });
  });
}
