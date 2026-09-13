import { extractFromSource } from '../src/extraction';
import { detectLanguage, getSupportedLanguages, isLanguageSupported } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerPascalDelphiExtractionTests(): void {


  // =============================================================================
  // Pascal / Delphi Extraction
  // =============================================================================

  describe('Pascal / Delphi Extraction', () => {
    describe('Language detection', () => {
      it('should detect Pascal files', () => {
        expect(detectLanguage('UAuth.pas')).toBe('pascal');
        expect(detectLanguage('App.dpr')).toBe('pascal');
        expect(detectLanguage('Package.dpk')).toBe('pascal');
        expect(detectLanguage('App.lpr')).toBe('pascal');
        expect(detectLanguage('MainForm.dfm')).toBe('pascal');
        expect(detectLanguage('MainForm.fmx')).toBe('pascal');
      });

      it('should report Pascal as supported', () => {
        expect(isLanguageSupported('pascal')).toBe(true);
        expect(getSupportedLanguages()).toContain('pascal');
      });
    });

    describe('Unit extraction', () => {
      it('should extract unit as module', () => {
        const code = `unit MyUnit;\ninterface\nimplementation\nend.`;
        const result = extractFromSource('MyUnit.pas', code);

        const moduleNode = result.nodes.find((n) => n.kind === 'module');
        expect(moduleNode).toBeDefined();
        expect(moduleNode?.name).toBe('MyUnit');
        expect(moduleNode?.language).toBe('pascal');
      });

      it('should extract program as module', () => {
        const code = `program MyApp;\nbegin\nend.`;
        const result = extractFromSource('MyApp.dpr', code);

        const moduleNode = result.nodes.find((n) => n.kind === 'module');
        expect(moduleNode).toBeDefined();
        expect(moduleNode?.name).toBe('MyApp');
      });

      it('should fallback to filename when module name is empty', () => {
        // Some .dpr templates use "program;" without a name
        const code = `program;\nuses SysUtils;\nbegin\nend.`;
        const result = extractFromSource('Console.dpr', code);

        const moduleNode = result.nodes.find((n) => n.kind === 'module');
        expect(moduleNode).toBeDefined();
        expect(moduleNode?.name).toBe('Console');
      });
    });

    describe('Uses clause (imports)', () => {
      it('should extract uses as individual imports', () => {
        const code = `unit Test;\ninterface\nuses\n  System.SysUtils,\n  System.Classes;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const imports = result.nodes.filter((n) => n.kind === 'import');
        expect(imports.length).toBe(2);
        expect(imports.map((n) => n.name)).toContain('System.SysUtils');
        expect(imports.map((n) => n.name)).toContain('System.Classes');
      });

      it('should create unresolved references for imports', () => {
        const code = `unit Test;\ninterface\nuses\n  UAuth;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const importRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'imports'
        );
        expect(importRef).toBeDefined();
        expect(importRef?.referenceName).toBe('UAuth');
      });
    });

    describe('Class extraction', () => {
      it('should extract class declarations', () => {
        const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  public\n    procedure DoSomething;\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const classNode = result.nodes.find((n) => n.kind === 'class');
        expect(classNode).toBeDefined();
        expect(classNode?.name).toBe('TMyClass');
      });

      it('should extract class with inheritance', () => {
        const code = `unit Test;\ninterface\ntype\n  TChild = class(TParent)\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const extendsRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends'
        );
        expect(extendsRef).toBeDefined();
        expect(extendsRef?.referenceName).toBe('TParent');
      });

      it('should extract class with interface implementation', () => {
        const code = `unit Test;\ninterface\ntype\n  TService = class(TInterfacedObject, ILogger)\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const extendsRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends'
        );
        const implementsRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'implements'
        );
        expect(extendsRef?.referenceName).toBe('TInterfacedObject');
        expect(implementsRef?.referenceName).toBe('ILogger');
      });
    });

    describe('Record extraction', () => {
      it('should extract records as class nodes', () => {
        const code = `unit Test;\ninterface\ntype\n  TPoint = record\n    X: Double;\n    Y: Double;\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const classNode = result.nodes.find((n) => n.kind === 'class');
        expect(classNode).toBeDefined();
        expect(classNode?.name).toBe('TPoint');

        const fields = result.nodes.filter((n) => n.kind === 'field');
        expect(fields.length).toBe(2);
        expect(fields.map((f) => f.name)).toContain('X');
        expect(fields.map((f) => f.name)).toContain('Y');
      });
    });

    describe('Interface extraction', () => {
      it('should extract interface declarations', () => {
        const code = `unit Test;\ninterface\ntype\n  ILogger = interface\n    procedure Log(const AMsg: string);\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
        expect(ifaceNode).toBeDefined();
        expect(ifaceNode?.name).toBe('ILogger');
      });
    });

    describe('Method extraction', () => {
      it('should extract methods with visibility', () => {
        const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  private\n    FValue: Integer;\n  public\n    constructor Create;\n    function GetValue: Integer;\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const methods = result.nodes.filter((n) => n.kind === 'method');
        expect(methods.length).toBe(2);

        const createMethod = methods.find((m) => m.name === 'Create');
        expect(createMethod?.visibility).toBe('public');

        const getValue = methods.find((m) => m.name === 'GetValue');
        expect(getValue?.visibility).toBe('public');

        const fields = result.nodes.filter((n) => n.kind === 'field');
        const fValue = fields.find((f) => f.name === 'FValue');
        expect(fValue?.visibility).toBe('private');
      });

      it('should detect static methods (class methods)', () => {
        const code = `unit Test;\ninterface\ntype\n  THelper = class\n  public\n    class function Create: THelper; static;\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const methods = result.nodes.filter((n) => n.kind === 'method');
        const staticMethod = methods.find((m) => m.name === 'Create');
        expect(staticMethod?.isStatic).toBe(true);
      });
    });

    describe('Enum extraction', () => {
      it('should extract enums with members', () => {
        const code = `unit Test;\ninterface\ntype\n  TColor = (clRed, clGreen, clBlue);\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const enumNode = result.nodes.find((n) => n.kind === 'enum');
        expect(enumNode).toBeDefined();
        expect(enumNode?.name).toBe('TColor');

        const members = result.nodes.filter((n) => n.kind === 'enum_member');
        expect(members.length).toBe(3);
        expect(members.map((m) => m.name)).toEqual(['clRed', 'clGreen', 'clBlue']);
      });
    });

    describe('Property extraction', () => {
      it('should extract properties', () => {
        const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    property Name: string read FName write FName;\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const propNode = result.nodes.find((n) => n.kind === 'property');
        expect(propNode).toBeDefined();
        expect(propNode?.name).toBe('Name');
        expect(propNode?.visibility).toBe('public');
      });
    });

    describe('Constant extraction', () => {
      it('should extract constants', () => {
        const code = `unit Test;\ninterface\nconst\n  MAX_RETRIES = 3;\n  APP_NAME = 'MyApp';\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const constants = result.nodes.filter((n) => n.kind === 'constant');
        expect(constants.length).toBe(2);
        expect(constants.map((c) => c.name)).toContain('MAX_RETRIES');
        expect(constants.map((c) => c.name)).toContain('APP_NAME');
      });
    });

    describe('Type alias extraction', () => {
      it('should extract type aliases', () => {
        const code = `unit Test;\ninterface\ntype\n  TUserName = string;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const aliasNode = result.nodes.find((n) => n.kind === 'type_alias');
        expect(aliasNode).toBeDefined();
        expect(aliasNode?.name).toBe('TUserName');
      });
    });

    describe('Call extraction', () => {
      it('should extract calls from implementation bodies', () => {
        const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure DoWork;\n  end;\nimplementation\nprocedure TObj.DoWork;\nbegin\n  WriteLn('hello');\nend;\nend.`;
        const result = extractFromSource('Test.pas', code);

        const callRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'calls'
        );
        expect(callRef).toBeDefined();
        expect(callRef?.referenceName).toBe('WriteLn');
      });
    });

    describe('Containment edges', () => {
      it('should create contains edges for class members', () => {
        const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure Foo;\n  end;\nimplementation\nend.`;
        const result = extractFromSource('Test.pas', code);

        const classNode = result.nodes.find((n) => n.kind === 'class');
        const methodNode = result.nodes.find((n) => n.kind === 'method');
        expect(classNode).toBeDefined();
        expect(methodNode).toBeDefined();

        const containsEdge = result.edges.find(
          (e) => e.source === classNode?.id && e.target === methodNode?.id && e.kind === 'contains'
        );
        expect(containsEdge).toBeDefined();
      });
    });

    describe('Full fixture: UAuth.pas', () => {
      const code = `unit UAuth;

interface

uses
  System.SysUtils,
  System.Classes;

type
  ITokenValidator = interface
    ['{11111111-1111-1111-1111-111111111111}']
    function Validate(const AToken: string): Boolean;
  end;

  TAuthService = class(TInterfacedObject, ITokenValidator)
  private
    FToken: string;
    FLoginCount: Integer;
    procedure IncLoginCount;
  protected
    function GetToken: string;
  public
    constructor Create;
    destructor Destroy; override;
    function Validate(const AToken: string): Boolean;
    function Login(const AUser, APass: string): string;
    property Token: string read GetToken;
    property LoginCount: Integer read FLoginCount;
  end;

implementation

constructor TAuthService.Create;
begin
  inherited Create;
  FToken := '';
  FLoginCount := 0;
end;

destructor TAuthService.Destroy;
begin
  FToken := '';
  inherited Destroy;
end;

procedure TAuthService.IncLoginCount;
begin
  Inc(FLoginCount);
end;

function TAuthService.GetToken: string;
begin
  Result := FToken;
end;

function TAuthService.Validate(const AToken: string): Boolean;
begin
  Result := AToken <> '';
end;

function TAuthService.Login(const AUser, APass: string): string;
begin
  IncLoginCount;
  if Validate(AUser + ':' + APass) then
  begin
    FToken := AUser;
    Result := 'ok';
  end
  else
    Result := '';
end;

end.`;

      it('should extract all expected nodes', () => {
        const result = extractFromSource('UAuth.pas', code);

        expect(result.errors).toHaveLength(0);

        // Module
        const moduleNode = result.nodes.find((n) => n.kind === 'module');
        expect(moduleNode?.name).toBe('UAuth');

        // Imports
        const imports = result.nodes.filter((n) => n.kind === 'import');
        expect(imports.length).toBe(2);

        // Interface
        const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
        expect(ifaceNode?.name).toBe('ITokenValidator');

        // Class
        const classNode = result.nodes.find((n) => n.kind === 'class');
        expect(classNode?.name).toBe('TAuthService');

        // Methods
        const methods = result.nodes.filter((n) => n.kind === 'method');
        expect(methods.length).toBeGreaterThanOrEqual(6);
        expect(methods.map((m) => m.name)).toContain('Create');
        expect(methods.map((m) => m.name)).toContain('Destroy');
        expect(methods.map((m) => m.name)).toContain('Login');

        // Fields
        const fields = result.nodes.filter((n) => n.kind === 'field');
        expect(fields.length).toBe(2);
        expect(fields.every((f) => f.visibility === 'private')).toBe(true);

        // Properties
        const props = result.nodes.filter((n) => n.kind === 'property');
        expect(props.length).toBe(2);
        expect(props.map((p) => p.name)).toContain('Token');
        expect(props.map((p) => p.name)).toContain('LoginCount');
      });

      it('should extract inheritance and interface implementation', () => {
        const result = extractFromSource('UAuth.pas', code);

        const extendsRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends'
        );
        expect(extendsRef?.referenceName).toBe('TInterfacedObject');

        const implementsRef = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'implements'
        );
        expect(implementsRef?.referenceName).toBe('ITokenValidator');
      });

      it('should extract calls from implementation', () => {
        const result = extractFromSource('UAuth.pas', code);

        const callRefs = result.unresolvedReferences.filter(
          (r) => r.referenceKind === 'calls'
        );
        expect(callRefs.map((r) => r.referenceName)).toContain('Inc');
        expect(callRefs.map((r) => r.referenceName)).toContain('Validate');
      });
    });

    describe('Full fixture: UTypes.pas', () => {
      const code = `unit UTypes;

interface

uses
  System.SysUtils;

const
  C_MAX_RETRIES = 3;
  C_DEFAULT_NAME = 'Guest';

type
  TUserRole = (urAdmin, urEditor, urViewer);

  TPoint2D = record
    X: Double;
    Y: Double;
  end;

  TUserName = string;

  TUserInfo = class
  public
    type
      TAddress = record
        Street: string;
        City: string;
        Zip: string;
      end;
  private
    FName: TUserName;
    FRole: TUserRole;
    FAddress: TAddress;
  public
    constructor Create(const AName: TUserName; ARole: TUserRole);
    function GetDisplayName: string;
    class function CreateAdmin(const AName: TUserName): TUserInfo; static;
    property Name: TUserName read FName write FName;
    property Role: TUserRole read FRole;
    property Address: TAddress read FAddress write FAddress;
  end;

implementation

constructor TUserInfo.Create(const AName: TUserName; ARole: TUserRole);
begin
  FName := AName;
  FRole := ARole;
end;

function TUserInfo.GetDisplayName: string;
begin
  if FRole = urAdmin then
    Result := '[Admin] ' + FName
  else
    Result := FName;
end;

class function TUserInfo.CreateAdmin(const AName: TUserName): TUserInfo;
begin
  Result := TUserInfo.Create(AName, urAdmin);
end;

end.`;

      it('should extract enums with members', () => {
        const result = extractFromSource('UTypes.pas', code);

        const enumNode = result.nodes.find((n) => n.kind === 'enum');
        expect(enumNode?.name).toBe('TUserRole');

        const members = result.nodes.filter((n) => n.kind === 'enum_member');
        expect(members.length).toBe(3);
        expect(members.map((m) => m.name)).toEqual(['urAdmin', 'urEditor', 'urViewer']);
      });

      it('should extract constants', () => {
        const result = extractFromSource('UTypes.pas', code);

        const constants = result.nodes.filter((n) => n.kind === 'constant');
        expect(constants.length).toBe(2);
        expect(constants.map((c) => c.name)).toContain('C_MAX_RETRIES');
        expect(constants.map((c) => c.name)).toContain('C_DEFAULT_NAME');
      });

      it('should extract type aliases', () => {
        const result = extractFromSource('UTypes.pas', code);

        const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
        expect(aliases.map((a) => a.name)).toContain('TUserName');
      });

      it('should extract records as classes with fields', () => {
        const result = extractFromSource('UTypes.pas', code);

        const classes = result.nodes.filter((n) => n.kind === 'class');
        expect(classes.map((c) => c.name)).toContain('TPoint2D');

        // TPoint2D fields
        const fields = result.nodes.filter((n) => n.kind === 'field');
        expect(fields.map((f) => f.name)).toContain('X');
        expect(fields.map((f) => f.name)).toContain('Y');
      });

      it('should extract static class methods', () => {
        const result = extractFromSource('UTypes.pas', code);

        const methods = result.nodes.filter((n) => n.kind === 'method');
        const staticMethod = methods.find((m) => m.name === 'CreateAdmin');
        expect(staticMethod).toBeDefined();
        expect(staticMethod?.isStatic).toBe(true);
      });

      it('should extract nested types', () => {
        const result = extractFromSource('UTypes.pas', code);

        const classes = result.nodes.filter((n) => n.kind === 'class');
        expect(classes.map((c) => c.name)).toContain('TAddress');
      });
    });
  });
}
