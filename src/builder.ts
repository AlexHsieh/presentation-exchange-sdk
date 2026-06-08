import type { PresentationDefinitionV2 } from '@web5/credentials';
import { buildPresentationDefinition } from './definition.js';
import type { AttributeInput, BuildPresentationDefinitionInput, PresentationPolicy, SemanticAttribute, TargetCredentialTypeValue } from './types.js';

export class PresentationDefinitionBuilder {
  private input: Partial<BuildPresentationDefinitionInput> = {};
  private attributes: AttributeInput = {};

  id(value: string): this {
    this.input.id = value;
    return this;
  }

  name(value: string): this {
    this.input.name = value;
    return this;
  }

  purpose(value: string): this {
    this.input.purpose = value;
    return this;
  }

  requestType(value: string): this {
    this.input.requestType = value;
    return this;
  }

  targetCredentialType(value: TargetCredentialTypeValue): this {
    this.input.targetCredentialType = value;
    return this;
  }

  subject(value: string): this {
    this.input.subject = value;
    return this;
  }

  policy(value: PresentationPolicy): this {
    this.input.policy = value;
    return this;
  }

  require(attribute: SemanticAttribute, options?: { oneOf?: string[] }): this {
    if (options?.oneOf) {
      this.attributes[attribute as keyof AttributeInput] = options.oneOf as never;
    } else {
      this.attributes[attribute as keyof AttributeInput] = true as never;
    }
    return this;
  }

  expiresAfter(value: Date | string): this {
    this.input.expirationMinimum = value;
    return this;
  }

  build(): PresentationDefinitionV2 {
    return buildPresentationDefinition({
      id: required(this.input.id, 'id'),
      requestType: required(this.input.requestType, 'requestType'),
      targetCredentialType: required(this.input.targetCredentialType, 'targetCredentialType'),
      subject: required(this.input.subject, 'subject'),
      policy: required(this.input.policy, 'policy'),
      ...(this.input.name ? { name: this.input.name } : {}),
      ...(this.input.purpose ? { purpose: this.input.purpose } : {}),
      ...(this.input.expirationMinimum ? { expirationMinimum: this.input.expirationMinimum } : {}),
      attributes: this.attributes,
    });
  }
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}
