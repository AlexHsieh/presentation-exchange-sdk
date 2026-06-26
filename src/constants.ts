export const PolicyTier = {
  Human: 'human',
  Uniqueness: 'uniqueness',
} as const;

export const PersonalDataSource = {
  PlatformUserData: 'platformUserData',
  OfficialDocument: 'officialDocument',
  NotProvided: 'notProvided',
} as const;

export const PERSONAL_DATA_SOURCE_VALUES = Object.values(PersonalDataSource);

export function isPersonalDataSourceValue(value: unknown): value is (typeof PersonalDataSource)[keyof typeof PersonalDataSource] {
  return typeof value === 'string' && (PERSONAL_DATA_SOURCE_VALUES as string[]).includes(value);
}

export const TargetCredentialType = {
  Human: 'HumanVerifiableCredential',
  Uniqueness: 'UniquenessVerifiableCredential',
} as const;

export const RequestVcType = {
  PresentationDefinitionTargetRequest: 'PresentationDefinitionTargetRequestVerifiableCredential',
} as const;

export const PresentationPath = {
  Type: '$.vc.type[*]',
  TypeCompat: '$.vc.type',
  ExpirationDate: '$.vc.expirationDate',
  IssuanceDate: '$.vc.issuanceDate',
  SubjectId: '$.vc.credentialSubject.id',
  PdRequestType: '$.vc.credentialSubject.pdRequestType',
  Name: '$.vc.credentialSubject.name',
  ProfilePicture: '$.vc.credentialSubject.profilePicture',
  ProfileUrl: '$.vc.credentialSubject.profileUrl',
  SocialMedia: '$.vc.credentialSubject.socialMedia',
  Nationality: '$.vc.credentialSubject.nationality',
} as const;

export const SemanticAttributePath = {
  type: PresentationPath.Type,
  expirationDate: PresentationPath.ExpirationDate,
  issuanceDate: PresentationPath.IssuanceDate,
  subjectId: PresentationPath.SubjectId,
  pdRequestType: PresentationPath.PdRequestType,
  name: PresentationPath.Name,
  profilePicture: PresentationPath.ProfilePicture,
  profileUrl: PresentationPath.ProfileUrl,
  socialMedia: PresentationPath.SocialMedia,
  nationality: PresentationPath.Nationality,
} as const;

export const constants = {
  PolicyTier,
  PersonalDataSource,
  PERSONAL_DATA_SOURCE_VALUES,
  TargetCredentialType,
  RequestVcType,
  PresentationPath,
  SemanticAttributePath,
} as const;
