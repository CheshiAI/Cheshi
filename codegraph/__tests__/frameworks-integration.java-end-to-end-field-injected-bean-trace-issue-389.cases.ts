import { CodeGraph } from '../src';
import { IBATIS_DTD_URL, MYBATIS_DTD_URL } from './frameworks-integration.fixtures';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerJavaEndToEndFieldInjectedBeanTraceIssue389Tests(): void {


  describe('Java end-to-end — field-injected bean trace (issue #389)', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    // Mirrors the issue's Spring MVC pattern:
    //   UserAction(@Resource UserBO userbo).toLogin2() -> this.userbo.toLogin2()
    //     -> UserBO.toLogin2() -> userService.toLogin() -> UserService.toLogin (iface)
    //     -> UserServiceImpl.toLogin() via interface→impl synthesis.
    // Without the extractor `this.` strip + field-typed receiver lookup, the very
    // first hop (controller -> bean) was missing entirely, breaking trace.
    it('connects controller -> @Resource bean -> interface -> impl end-to-end', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-bean-'));
      const javaDir = path.join(tmpDir, 'src/main/java/com/example/user');
      fs.mkdirSync(path.join(javaDir, 'action'), { recursive: true });
      fs.mkdirSync(path.join(javaDir, 'bo'), { recursive: true });
      fs.mkdirSync(path.join(javaDir, 'service'), { recursive: true });
      fs.mkdirSync(path.join(javaDir, 'service/impl'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'pom.xml'),
        '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n'
      );
      fs.writeFileSync(
        path.join(javaDir, 'action/UserAction.java'),
        'package com.example.user.action;\n' +
        'import com.example.user.bo.UserBO;\n' +
        'import javax.annotation.Resource;\n' +
        '@org.springframework.stereotype.Controller\n' +
        'public class UserAction {\n' +
        '  @Resource(name = "userBO") private UserBO userbo;\n' +
        '  public void toLogin2() { this.userbo.toLogin2(); }\n' +
        '}\n'
      );
      fs.writeFileSync(
        path.join(javaDir, 'bo/UserBO.java'),
        'package com.example.user.bo;\n' +
        'import com.example.user.service.UserService;\n' +
        'import javax.annotation.Resource;\n' +
        '@org.springframework.stereotype.Component("userBO")\n' +
        'public class UserBO {\n' +
        '  @Resource private UserService userService;\n' +
        '  public void toLogin2() { userService.toLogin(); }\n' +
        '}\n'
      );
      fs.writeFileSync(
        path.join(javaDir, 'service/UserService.java'),
        'package com.example.user.service;\n' +
        'public interface UserService { void toLogin(); }\n'
      );
      fs.writeFileSync(
        path.join(javaDir, 'service/impl/UserServiceImpl.java'),
        'package com.example.user.service.impl;\n' +
        'import com.example.user.service.UserService;\n' +
        '@org.springframework.stereotype.Service("userService")\n' +
        'public class UserServiceImpl implements UserService {\n' +
        '  public void toLogin() { }\n' +
        '}\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const methods = cg.getNodesByKind('method');
      const find = (cls: string, name: string) =>
        methods.find((m) => m.name === name && m.filePath.endsWith(`${cls}.java`));

      const action = find('UserAction', 'toLogin2');
      const bo = find('UserBO', 'toLogin2');
      const svc = find('UserService', 'toLogin');
      const impl = find('UserServiceImpl', 'toLogin');
      expect(action).toBeDefined();
      expect(bo).toBeDefined();
      expect(svc).toBeDefined();
      expect(impl).toBeDefined();

      // UserAction.toLogin2 -> UserBO.toLogin2 (the regressed hop — `this.userbo`
      // receiver was emitted verbatim and the field-type lookup didn't exist).
      const actionToBo = cg.getOutgoingEdges(action!.id).find((e) => e.target === bo!.id);
      expect(actionToBo, 'controller `this.userbo.toLogin2()` should reach UserBO.toLogin2').toBeDefined();
      expect(actionToBo!.kind).toBe('calls');

      // UserBO.toLogin2 -> UserService.toLogin (plain identifier receiver, works pre-fix).
      const boToSvc = cg.getOutgoingEdges(bo!.id).find((e) => e.target === svc!.id);
      expect(boToSvc).toBeDefined();

      // UserService.toLogin -> UserServiceImpl.toLogin (interface->impl synth).
      const svcToImpl = cg.getOutgoingEdges(svc!.id).find((e) => e.target === impl!.id);
      expect(svcToImpl).toBeDefined();

      cg.close();
    });

    it('bridges a Java mapper interface method to its MyBatis XML statement (incl. SQL fragments)', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mybatis-'));
      const javaDir = path.join(tmpDir, 'src/main/java/com/example/dao');
      const xmlDir = path.join(tmpDir, 'src/main/resources/mappers');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'pom.xml'),
        '<project><dependencies><dependency><groupId>org.mybatis</groupId><artifactId>mybatis</artifactId></dependency></dependencies></project>\n'
      );
      fs.writeFileSync(
        path.join(javaDir, 'UserDAOMapper.java'),
        'package com.example.dao;\n' +
        'public interface UserDAOMapper {\n' +
        '  Object getById(int id);\n' +
        '  int updateUser(Object u);\n' +
        '}\n'
      );
      fs.writeFileSync(
        path.join(xmlDir, 'UserDAOMapper.xml'),
      /* language=TEXT */ '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "' + MYBATIS_DTD_URL + '">\n' +
        '<mapper namespace="com.example.dao.UserDAOMapper">\n' +
        '  <sql id="userCols">id, name, email</sql>\n' +
        '  <select id="getById" parameterType="int" resultType="User">\n' +
        '    SELECT <include refid="userCols"/> FROM users WHERE id = #{id}\n' +
        '  </select>\n' +
        '  <update id="updateUser" parameterType="User">\n' +
        '    UPDATE users SET name=#{name}, email=#{email} WHERE id=#{id}\n' +
        '  </update>\n' +
        '</mapper>\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const methods = cg.getNodesByKind('method');
      const getByIdJava = methods.find((m) => m.name === 'getById' && m.language === 'java');
      const getByIdXml = methods.find((m) => m.name === 'getById' && m.language === 'xml');
      const updateJava = methods.find((m) => m.name === 'updateUser' && m.language === 'java');
      const updateXml = methods.find((m) => m.name === 'updateUser' && m.language === 'xml');
      const sqlFrag = methods.find((m) => m.name === 'userCols' && m.language === 'xml');
      expect(getByIdJava).toBeDefined();
      expect(getByIdXml).toBeDefined();
      expect(updateJava).toBeDefined();
      expect(updateXml).toBeDefined();
      expect(sqlFrag).toBeDefined();

      // XML statement qualified name must be `<namespace>::<id>` so the
      // synthesizer can match against the Java method's `<Class>::<method>`
      // suffix — this is the load-bearing contract between extractor + synthesis.
      expect(getByIdXml!.qualifiedName).toBe('com.example.dao.UserDAOMapper::getById');

      // Bridge: Java mapper method -> XML statement, kind 'calls'.
      const j2xGet = cg.getOutgoingEdges(getByIdJava!.id).find((e) => e.target === getByIdXml!.id);
      expect(j2xGet, 'Java getById should reach the XML <select id="getById">').toBeDefined();
      expect(j2xGet!.kind).toBe('calls');
      const j2xUpd = cg.getOutgoingEdges(updateJava!.id).find((e) => e.target === updateXml!.id);
      expect(j2xUpd, 'Java updateUser should reach the XML <update id="updateUser">').toBeDefined();

      // <include refid="userCols"/> inside <select> -> <sql id="userCols"> in same mapper.
      const incEdge = cg.getOutgoingEdges(getByIdXml!.id).find((e) => e.target === sqlFrag!.id);
      expect(incEdge, '<include refid="userCols"/> should reach the <sql> fragment').toBeDefined();

      cg.close();
    });

    it('covers legacy iBatis <sqlMap> statements and keeps same-line vendor-split pairs (#1182)', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ibatis-'));
      const xmlDir = path.join(tmpDir, 'src/main/resources/sqlmaps');
      fs.mkdirSync(xmlDir, { recursive: true });

      // iBatis 2 sqlMap with an explicit namespace.
      fs.writeFileSync(
        path.join(xmlDir, 'Account.xml'),
      /* language=TEXT */ `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE sqlMap PUBLIC "-//iBATIS.com//DTD SQL Map 2.0//EN" "${IBATIS_DTD_URL}">
<sqlMap namespace='Account'>
  <sql id='cols'>id, name, email</sql>
  <select id='getById' resultClass='Account'>SELECT <include refid='cols'/> FROM account WHERE id = #id#</select>
  <insert id='insert' parameterClass='Account'>INSERT INTO account (id) VALUES (#id#)</insert>
  <!-- <select id="disabled">SELECT 0</select> -->
</sqlMap>
`
      );
      // Namespace-less sqlMap whose ids carry the qualifier as `Map.statement`.
      fs.writeFileSync(
        path.join(xmlDir, 'LegacyDao.xml'),
      /* language=TEXT */ `<sqlMap>
  <select id="LegacyDao.findAll" resultClass="Row">SELECT * FROM t</select>
</sqlMap>
`
      );
      // MyBatis mapper with a vendor-split databaseId pair written on ONE line —
      // same qualifiedName + same start line. Before the id-hash fold both nodes
      // hashed identically and INSERT OR REPLACE dropped one.
      fs.writeFileSync(
        path.join(xmlDir, 'VendorMapper.xml'),
      /* language=TEXT */ '<mapper namespace="com.example.VendorMapper">\n' +
        '<select id="findUser" databaseId="oracle">SELECT 1 FROM dual</select><select id="findUser" databaseId="mysql">SELECT 1</select>\n' +
        '</mapper>\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const xmlMethods = cg.getNodesByKind('method').filter((n) => n.language === 'xml');
      const qnames = xmlMethods.map((n) => n.qualifiedName);

      // iBatis statements now land in the graph (was zero coverage before #1182).
      expect(qnames).toContain('Account::getById');
      expect(qnames).toContain('Account::insert');
      expect(qnames).toContain('Account::cols');
      expect(qnames).toContain('LegacyDao::findAll');
      // The commented-out statement produced no node.
      expect(qnames).not.toContain('Account::disabled');

      // <include refid='cols'/> resolves to the <sql> fragment in the same map.
      const getById = xmlMethods.find((n) => n.qualifiedName === 'Account::getById');
      const cols = xmlMethods.find((n) => n.qualifiedName === 'Account::cols');
      expect(getById).toBeDefined();
      expect(cols).toBeDefined();
      const incEdge = cg.getOutgoingEdges(getById!.id).find((e) => e.target === cols!.id);
      expect(incEdge, "iBatis <include refid='cols'/> should reach the <sql> fragment").toBeDefined();

      // Both vendor-split statements survive the DB write (the collision fix).
      const findUser = xmlMethods.filter((n) => n.name === 'findUser');
      expect(findUser, 'both databaseId variants of findUser should survive').toHaveLength(2);
      expect(new Set(findUser.map((n) => n.id)).size).toBe(2);

      cg.close();
    });

    it('binds @Value / @ConfigurationProperties to YAML + .properties keys (incl. relaxed binding)', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-config-'));
      const javaDir = path.join(tmpDir, 'src/main/java/com/example');
      const resDir = path.join(tmpDir, 'src/main/resources');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'pom.xml'),
        '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n'
      );
      fs.writeFileSync(
        path.join(resDir, 'application.yml'),
        'app:\n' +
        '  cache:\n' +
        '    name:\n' +
        '      user-token: "example-service:auth:token"\n' +
        '    enabled: true\n' +
        'db:\n' +
        '  url: "jdbc:mysql://localhost/x"\n'
      );
      fs.writeFileSync(
        path.join(resDir, 'application.properties'),
        'app.retry-count=3\n'
      );
      fs.writeFileSync(
        path.join(javaDir, 'CacheConfig.java'),
        'package com.example;\n' +
        'import org.springframework.beans.factory.annotation.Value;\n' +
        'public class CacheConfig {\n' +
        '  @Value("${app.cache.name.user-token}") private String tokenCacheName;\n' +
        '  @Value("${app.cache.enabled:true}") private boolean enabled;\n' +
        '  // relaxed binding: java camelCase, properties kebab-case\n' +
        '  @Value("${app.retryCount}") private int retry;\n' +
        '}\n'
      );
      fs.writeFileSync(
        path.join(javaDir, 'CacheProperties.java'),
        'package com.example;\n' +
        'import org.springframework.boot.context.properties.ConfigurationProperties;\n' +
        '@ConfigurationProperties(prefix = "app.cache")\n' +
        'public class CacheProperties { private boolean enabled; }\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      // YAML/properties leaf keys: one constant node per dotted path.
      const cfgKeys = cg
        .getNodesByKind('constant')
        .filter((n) => n.language === 'yaml' || n.language === 'properties');
      const cfgByQn = (qn: string) => cfgKeys.find((n) => n.qualifiedName === qn);
      expect(cfgByQn('app.cache.name.user-token')).toBeDefined();
      expect(cfgByQn('app.cache.enabled')).toBeDefined();
      expect(cfgByQn('db.url')).toBeDefined();
      expect(cfgByQn('app.retry-count')).toBeDefined();

      // @Value("${app.cache.name.user-token}") -> the YAML leaf key.
      const valueBindings = cg
        .getNodesByKind('constant')
        .filter((n) => n.id.startsWith('spring-value:'));
      const userToken = valueBindings.find((n) => n.name === 'app.cache.name.user-token');
      expect(userToken).toBeDefined();
      const userTokenEdges = cg.getOutgoingEdges(userToken!.id);
      const userTokenTarget = userTokenEdges.find((e) =>
        cfgKeys.some((c) => c.id === e.target && c.qualifiedName === 'app.cache.name.user-token'),
      );
      expect(userTokenTarget, '@Value should reference the YAML leaf key').toBeDefined();

      // Default-value form `${k:default}` — strip the `:default` and bind the key.
      const enabledBind = valueBindings.find((n) => n.name === 'app.cache.enabled');
      expect(enabledBind).toBeDefined();
      expect(cg.getOutgoingEdges(enabledBind!.id).some((e) => {
        const t = cfgByQn('app.cache.enabled');
        return t && e.target === t.id;
      })).toBe(true);

      // Relaxed binding: `app.retryCount` (camel) -> `app.retry-count` (kebab).
      const retryBind = valueBindings.find((n) => n.name === 'app.retryCount');
      expect(retryBind).toBeDefined();
      expect(cg.getOutgoingEdges(retryBind!.id).some((e) => {
        const t = cfgByQn('app.retry-count');
        return t && e.target === t.id;
      })).toBe(true);

      // @ConfigurationProperties(prefix="app.cache") -> a key under that prefix.
      const cpBindings = cg
        .getNodesByKind('constant')
        .filter((n) => n.id.startsWith('spring-cp:'));
      const cpAppCache = cpBindings.find((n) => n.name === 'app.cache');
      expect(cpAppCache).toBeDefined();
      const cpEdges = cg.getOutgoingEdges(cpAppCache!.id);
      expect(cpEdges.length).toBeGreaterThan(0);

      cg.close();
    });

    it('binds a config key only for `references` refs, never a same-named method call (#1180)', async () => {
      // `service.process` is BOTH a yaml key and a `service.process()` method call.
      // canonicalConfigKey collapses them to the same token, so before #1180 the
      // method call (kind `calls`) fell into the Spring config-key branch and
      // mis-resolved to the YAML constant at 0.9 confidence — a wrong edge, and the
      // uncached constant scan that made large Java/Kotlin indexes take ~1h. The
      // branch is now gated to `references` (only @Value/@ConfigurationProperties).
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-kindgate-'));
      const javaDir = path.join(tmpDir, 'src/main/java/com/example');
      const resDir = path.join(tmpDir, 'src/main/resources');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'pom.xml'),
        '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n'
      );
      fs.writeFileSync(path.join(resDir, 'application.yml'), 'service:\n  process: "enabled"\n');
      fs.writeFileSync(
        path.join(javaDir, 'Worker.java'),
        'package com.example;\n' +
        'import org.springframework.beans.factory.annotation.Value;\n' +
        'class Processor { void process() {} }\n' +
        'public class Worker {\n' +
        '  private Processor service;\n' +
        '  @Value("${service.process}") private String sp;\n' +
        '  void run() { service.process(); }\n' +
        '}\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const yamlKey = cg
        .getNodesByKind('constant')
        .find((n) => n.language === 'yaml' && n.qualifiedName === 'service.process');
      expect(yamlKey, 'yaml key service.process should be indexed').toBeDefined();

      // `references` ref (@Value) DOES bind to the config key.
      const valueBind = cg
        .getNodesByKind('constant')
        .find((n) => n.id.startsWith('spring-value:') && n.name === 'service.process');
      expect(valueBind).toBeDefined();
      expect(
        cg.getOutgoingEdges(valueBind!.id).some((e) => e.target === yamlKey!.id),
        '@Value should still bind to the yaml key',
      ).toBe(true);

      // `calls` ref (service.process()) must NOT bind to the config key.
      const run = cg.getNodesByKind('method').find((n) => n.name === 'run');
      expect(run).toBeDefined();
      expect(
        cg.getOutgoingEdges(run!.id).some((e) => e.target === yamlKey!.id),
        'a method call must never resolve to a config-key constant',
      ).toBe(false);

      cg.close();
    });

    it('emits only a file node for non-MyBatis XML (pom.xml, beans.xml, log4j.xml)', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-xml-non-mybatis-'));
      fs.writeFileSync(
        path.join(tmpDir, 'pom.xml'),
        '<project><groupId>x</groupId><artifactId>y</artifactId></project>\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'log4j.xml'),
        '<?xml version="1.0"?><Configuration><Loggers><Root level="info"/></Loggers></Configuration>\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();
      // No method nodes — non-mapper XML produces no symbols (just file rows).
      expect(cg.getNodesByKind('method').filter((n) => n.language === 'xml').length).toBe(0);
      cg.close();
    });

    it('resolves a `this.field.method()` call to a unique implementation class', async () => {
      // Standalone test of the extractor `this.` strip: even without Spring annotations,
      // `this.svc.run()` where `svc` is typed as a concrete class should route to that
      // class's method. This is the general Java fix, Spring is only one consumer.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-this-field-'));
      fs.writeFileSync(
        path.join(tmpDir, 'App.java'),
        'class Svc { public void run() { } }\n' +
        'class App {\n' +
        '  private Svc svc;\n' +
        '  public void go() { this.svc.run(); }\n' +
        '}\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const methods = cg.getNodesByKind('method');
      const go = methods.find((m) => m.name === 'go');
      const run = methods.find((m) => m.name === 'run');
      expect(go && run).toBeTruthy();

      const edge = cg.getOutgoingEdges(go!.id).find((e) => e.target === run!.id);
      expect(edge, '`this.svc.run()` should resolve to Svc.run').toBeDefined();

      cg.close();
    });
  });
}
