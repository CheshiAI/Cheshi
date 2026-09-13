import { beforeAll } from 'bun:test';
import { initGrammars, loadAllGrammars } from '../src';
import { registerCEndToEndVirtualOverrideSynthesisTests } from './frameworks-integration.c-end-to-end-virtual-override-synthesis.cases';
import { registerDjangoEndToEndFrameworkExtractionTests } from './frameworks-integration.django-end-to-end-framework-extraction.cases';
import { registerFlaskEndToEndFrameworkExtractionTests } from './frameworks-integration.flask-end-to-end-framework-extraction.cases';
import { registerFlutterEndToEndSetstateBuildSynthesisTests } from './frameworks-integration.flutter-end-to-end-setstate-build-synthesis.cases';
import { registerGoGrpcStubImplSynthesisTests } from './frameworks-integration.go-grpc-stub-impl-synthesis.cases';
import { registerJavaAnonymousClassOverrideSynthesisEndToEndTests } from './frameworks-integration.java-anonymous-class-override-synthesis-end-to-end.cases';
import { registerJavaEndToEndFieldInjectedBeanTraceIssue389Tests } from './frameworks-integration.java-end-to-end-field-injected-bean-trace-issue-389.cases';
import { registerJvmFqnImportsEndToEndTests } from './frameworks-integration.jvm-fqn-imports-end-to-end.cases';
import { registerReactRouterEndToEndRouteExtractionTsxJsxTests } from './frameworks-integration.react-router-end-to-end-route-extraction-tsx-jsx.cases';
import { registerTerraformEndToEndModuleBoundaryResolutionTests } from './frameworks-integration.terraform-end-to-end-module-boundary-resolution.cases';
import { registerTerraformFollowUpsRemoteStateBridgeProviderAliasMovedBlocksTests } from './frameworks-integration.terraform-follow-ups-remote-state-bridge-provider-alias-moved-blocks.cases';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

registerDjangoEndToEndFrameworkExtractionTests();

registerFlaskEndToEndFrameworkExtractionTests();

registerFlutterEndToEndSetstateBuildSynthesisTests();

registerCEndToEndVirtualOverrideSynthesisTests();

registerJavaEndToEndFieldInjectedBeanTraceIssue389Tests();

registerJvmFqnImportsEndToEndTests();

registerJavaAnonymousClassOverrideSynthesisEndToEndTests();

registerGoGrpcStubImplSynthesisTests();

registerReactRouterEndToEndRouteExtractionTsxJsxTests();

registerTerraformEndToEndModuleBoundaryResolutionTests();

registerTerraformFollowUpsRemoteStateBridgeProviderAliasMovedBlocksTests();
