import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerCfmlExtractionTests(): void {


  // =============================================================================
  // CFML (ColdFusion Markup Language — .cfc/.cfm tag-based and bare-script, .cfs)
  // =============================================================================

  describe('CFML Extraction', () => {
    describe('Language detection', () => {
      it('should detect .cfc/.cfm as cfml and .cfs as cfscript', () => {
        expect(detectLanguage('Service.cfc')).toBe('cfml');
        expect(detectLanguage('index.cfm')).toBe('cfml');
        expect(detectLanguage('Helper.cfs')).toBe('cfscript');
      });

      it('should report cfml and cfscript as supported', () => {
        expect(isLanguageSupported('cfml')).toBe(true);
        expect(isLanguageSupported('cfscript')).toBe(true);
        expect(getSupportedLanguages()).toContain('cfml');
        expect(getSupportedLanguages()).toContain('cfscript');
      });
    });

    describe('Bare-script .cfc (component { ... })', () => {
      const code = /* language=TEXT */ `
component extends="BaseService" implements="IService" {

    property name="name" type="string";

    function init(required string name) {
        variables.name = arguments.name;
        return this;
    }

    public string function getName() {
        return variables.name;
    }

    private void function logSomething(required string msg) {
        writeLog(text=msg);
    }
}
`;

      it('should name the component from the file name (the grammar has no name field)', () => {
        const result = extractFromSource('SampleService.cfc', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        expect(cls).toBeDefined();
        expect(cls?.name).toBe('SampleService');
        expect(cls?.language).toBe('cfml');
      });

      it('should extract methods with visibility and contains edges to the class', () => {
        const result = extractFromSource('SampleService.cfc', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        const methods = result.nodes.filter((n) => n.kind === 'method');
        expect(methods.map((m) => m.name)).toEqual(
          expect.arrayContaining(['init', 'getName', 'logSomething'])
        );
        const logSomething = methods.find((m) => m.name === 'logSomething');
        expect(logSomething?.visibility).toBe('private');
        const containsLog = result.edges.find(
          (e) => e.source === cls?.id && e.target === logSomething?.id && e.kind === 'contains'
        );
        expect(containsLog).toBeDefined();
      });

      it('should extract extends/implements as unresolved references from the class', () => {
        const result = extractFromSource('SampleService.cfc', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        const extendsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'extends');
        expect(extendsRef?.referenceName).toBe('BaseService');
        expect(extendsRef?.fromNodeId).toBe(cls?.id);
        const implRef = result.unresolvedReferences.find((r) => r.referenceKind === 'implements');
        expect(implRef?.referenceName).toBe('IService');
        expect(implRef?.fromNodeId).toBe(cls?.id);
      });
    });

    describe('Standalone .cfs (pure CFScript)', () => {
      it('should also name an anonymous component from the file name', () => {
        const code = /* language=TEXT */ `
component {
    function ping() {
        return "pong";
    }
}
`;
        const result = extractFromSource('Sample.cfs', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        expect(cls).toBeDefined();
        expect(cls?.name).toBe('Sample');
        expect(cls?.language).toBe('cfscript');
      });

      it('should extract top-level imports with no enclosing component', () => {
        const code = /* language=TEXT */ `
import com.foo.Bar;
import foo.cfm;
`;
        const result = extractFromSource('Includes.cfs', code);
        const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
        expect(imports).toContain('com.foo.Bar');
        expect(imports).toContain('foo.cfm');
      });
    });

    describe('Tag-based .cfc (<cfcomponent>/<cffunction>)', () => {
      const code = /* language=TEXT */ `<cfcomponent extends="Base" implements="IFoo,IBar" output="false">
\t<cffunction name="getName" access="public" returntype="string">
\t\t<cfreturn this.name>
\t</cffunction>
\t<cffunction name="doWork" access="private" returntype="void">
\t\t<cfscript>
\t\t\tvar x = helper();
\t\t\tanotherCall(x);
\t\t</cfscript>
\t</cffunction>
</cfcomponent>
`;

      it('should name the component from the file name when the tag has no name attribute', () => {
        const result = extractFromSource('TagStyle.cfc', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        expect(cls?.name).toBe('TagStyle');
        expect(cls?.language).toBe('cfml');
      });

      it('should prefer an explicit name attribute on the cfcomponent tag', () => {
        const named = /* language=TEXT */ `<cfcomponent name="ExplicitName">\n<cffunction name="a"><cfreturn 1></cffunction>\n</cfcomponent>`;
        const result = extractFromSource('File.cfc', named);
        expect(result.nodes.find((n) => n.kind === 'class')?.name).toBe('ExplicitName');
      });

      it('should extract cffunction tags as methods with access-derived visibility', () => {
        const result = extractFromSource('TagStyle.cfc', code);
        const methods = result.nodes.filter((n) => n.kind === 'method');
        expect(methods.map((m) => m.name)).toEqual(expect.arrayContaining(['getName', 'doWork']));
        const getName = methods.find((m) => m.name === 'getName');
        expect(getName?.visibility).toBe('public');
        expect(getName?.returnType).toBe('string');
        const doWork = methods.find((m) => m.name === 'doWork');
        expect(doWork?.visibility).toBe('private');
      });

      it('should not double-extract symbols from the component body (implicit-end-tag walk)', () => {
        const result = extractFromSource('TagStyle.cfc', code);
        const methods = result.nodes.filter((n) => n.kind === 'method' && n.name === 'getName');
        expect(methods).toHaveLength(1);
        const doWorkMethods = result.nodes.filter((n) => n.kind === 'method' && n.name === 'doWork');
        expect(doWorkMethods).toHaveLength(1);
      });

      it('should delegate <cfscript> tag bodies to the cfscript grammar and attribute calls to the enclosing method', () => {
        const result = extractFromSource('TagStyle.cfc', code);
        const doWork = result.nodes.find((n) => n.kind === 'method' && n.name === 'doWork');
        const helperCall = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'helper'
        );
        expect(helperCall?.fromNodeId).toBe(doWork?.id);
      });

      it('should produce exactly one correctly-ranged file node, not a leaked snippet-scoped one', () => {
        const result = extractFromSource('TagStyle.cfc', code);
        const fileNodes = result.nodes.filter((n) => n.kind === 'file');
        expect(fileNodes).toHaveLength(1);
        expect(fileNodes[0].startLine).toBe(1);
        const cls = result.nodes.find((n) => n.kind === 'class');
        const containsClass = result.edges.find(
          (e) => e.source === fileNodes[0].id && e.target === cls?.id && e.kind === 'contains'
        );
        expect(containsClass).toBeDefined();
      });
    });

    describe('Top-level cffunction with no enclosing cfcomponent (.cfm template)', () => {
      it('should extract as a top-level function contained by the file', () => {
        const code = /* language=TEXT */ `<cffunction name="helper" access="public" returntype="string">
\t<cfreturn "hi">
</cffunction>
`;
        const result = extractFromSource('helper.cfm', code);
        const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
        expect(fn).toBeDefined();
        const fileNode = result.nodes.find((n) => n.kind === 'file');
        const containsFn = result.edges.find(
          (e) => e.source === fileNode?.id && e.target === fn?.id && e.kind === 'contains'
        );
        expect(containsFn).toBeDefined();
      });
    });

    describe('<cfscript> nested inside control-flow tags (<cfif>/<cfloop>/<cftry>)', () => {
      it('should delegate a <cfscript> body nested inside <cfif> within a <cffunction>', () => {
        const code = /* language=TEXT */ `<cfcomponent>
<cffunction name="doStuff">
  <cfif true>
    <cfscript>
      helper();
    </cfscript>
  </cfif>
</cffunction>
</cfcomponent>
`;
        const result = extractFromSource('Nested.cfc', code);
        const doStuff = result.nodes.find((n) => n.kind === 'method' && n.name === 'doStuff');
        expect(doStuff).toBeDefined();
        const helperCall = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'helper'
        );
        expect(helperCall?.fromNodeId).toBe(doStuff?.id);
      });

      it('should delegate a <cfscript> body nested inside <cfif> at top-level component scope', () => {
        const code = /* language=TEXT */ `<cfcomponent>
<cfif true>
  <cfscript>
    topLevelHelper();
  </cfscript>
</cfif>
</cfcomponent>
`;
        const result = extractFromSource('Nested2.cfc', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        expect(cls).toBeDefined();
        const helperCall = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'topLevelHelper'
        );
        expect(helperCall?.fromNodeId).toBe(cls?.id);
      });
    });

    describe('<cfquery> SQL bodies (cfquery grammar)', () => {
      it('should extract a call expression embedded in a #hash# inside the SQL body', () => {
        const code = /* language=TEXT */ `<cfcomponent>
<cffunction name="getUsers">
  <cfquery name="qUsers" datasource="#variables.dsn#">
    SELECT id, name FROM users WHERE owner = #getCurrentUser().getId()#
  </cfquery>
  <cfreturn qUsers>
</cffunction>
</cfcomponent>
`;
        const result = extractFromSource('Query.cfc', code);
        const getUsers = result.nodes.find((n) => n.kind === 'method' && n.name === 'getUsers');
        expect(getUsers).toBeDefined();
        const getCurrentUserCall = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'getCurrentUser'
        );
        expect(getCurrentUserCall?.fromNodeId).toBe(getUsers?.id);
        const getIdCall = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls' && r.referenceName === 'getId'
        );
        expect(getIdCall?.fromNodeId).toBe(getUsers?.id);
      });
    });

    describe('UTF-8 BOM handling (common in CFML saved by Windows editors)', () => {
      it('should route a BOM-prefixed tag-based .cfc to the tag grammar, not the script grammar', () => {
        const code = /* language=TEXT */ `\uFEFF<cfcomponent output="false">\n<cffunction name="configure" access="public">\n<cfreturn 1>\n</cffunction>\n</cfcomponent>\n`;
        const result = extractFromSource('ModuleConfig.cfc', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        expect(cls?.name).toBe('ModuleConfig');
        const configure = result.nodes.find((n) => n.kind === 'method' && n.name === 'configure');
        expect(configure).toBeDefined();
      });

      it('should still treat a BOM-prefixed bare-script .cfc as script', () => {
        const code = /* language=TEXT */ `\uFEFFcomponent {\n  function ping() { return "pong"; }\n}\n`;
        const result = extractFromSource('Ping.cfc', code);
        expect(result.nodes.find((n) => n.kind === 'class')?.name).toBe('Ping');
        expect(result.nodes.find((n) => n.kind === 'method')?.name).toBe('ping');
      });
    });

    describe('Unquoted tag attribute values (legal in older CFML)', () => {
      it('should extract functions and inheritance from unquoted attributes', () => {
        const code = /* language=TEXT */ `<cfcomponent extends=Base>\n<cffunction name=doThing access=private>\n<cfreturn 1>\n</cffunction>\n</cfcomponent>\n`;
        const result = extractFromSource('Unquoted.cfc', code);
        const doThing = result.nodes.find((n) => n.kind === 'method' && n.name === 'doThing');
        expect(doThing).toBeDefined();
        expect(doThing?.visibility).toBe('private');
        const extendsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'extends');
        expect(extendsRef?.referenceName).toBe('Base');
      });
    });

    describe('Functions in a component-level <cfscript> block', () => {
      it('should classify them as methods of the component (ColdBox ModuleConfig shape)', () => {
        const code = /* language=TEXT */ `<cfcomponent output="false">\n<cfscript>\nfunction configure() {\n  return settings();\n}\nfunction onLoad() {\n  return 1;\n}\n</cfscript>\n</cfcomponent>\n`;
        const result = extractFromSource('ModuleConfig.cfc', code);
        const cls = result.nodes.find((n) => n.kind === 'class');
        const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
        expect(methods).toEqual(expect.arrayContaining(['configure', 'onLoad']));
        expect(result.nodes.filter((n) => n.kind === 'function')).toHaveLength(0);
        const configure = result.nodes.find((n) => n.kind === 'method' && n.name === 'configure');
        const containsEdge = result.edges.find(
          (e) => e.source === cls?.id && e.target === configure?.id && e.kind === 'contains'
        );
        expect(containsEdge).toBeDefined();
      });

      it('should keep kind function for a <cfscript> inside a cffunction body', () => {
        const code = /* language=TEXT */ `<cfcomponent>\n<cffunction name="outer">\n<cfscript>\nfunction innerHelper() { return 1; }\n</cfscript>\n</cffunction>\n</cfcomponent>\n`;
        const result = extractFromSource('Outer.cfc', code);
        expect(result.nodes.find((n) => n.name === 'outer')?.kind).toBe('method');
        expect(result.nodes.find((n) => n.name === 'innerHelper')?.kind).toBe('function');
      });
    });
  });
}
