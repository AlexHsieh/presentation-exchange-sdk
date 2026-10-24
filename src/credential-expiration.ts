import { Jwt, VerifiableCredential } from '@web5/credentials';
import { LocalKeyManager } from '@web5/crypto';
import { utils as didUtils } from '@web5/dids';

// Web5 rejects expired JWTs before checking their signature. This rejection-only
// path authenticates the original bytes before reporting credential expiry.
// It never accepts an expired JWT or changes clocks/normal verification behavior.
export async function isAuthenticExpiredCredential(jwt: string): Promise<boolean> {
  try {
    const { decoded, encoded } = Jwt.parse({ jwt });
    if (typeof decoded.payload.exp !== 'number' || !Number.isFinite(decoded.payload.exp)
      || decoded.payload.exp * 1000 > Date.now()) return false;
    const result = await Jwt.didResolver.dereference(decoded.header.kid!);
    const method = result.contentStream;
    if (result.dereferencingMetadata.error || !method || !didUtils.isDidVerificationMethod(method)) return false;
    const key = method.publicKeyJwk;
    if (!key || (key.alg && key.alg !== decoded.header.alg)) return false;
    return await new LocalKeyManager().verify({
      key,
      signature: new Uint8Array(Buffer.from(encoded.signature, 'base64url')),
      data: new TextEncoder().encode(`${encoded.header}.${encoded.payload}`),
    });
  } catch { return false; }
}

export async function hasAuthenticExpiredCredential(vpJwt: string): Promise<boolean> {
  try {
    const { payload } = await Jwt.verify({ jwt: vpJwt });
    const vp = payload.vp as { verifiableCredential?: unknown } | undefined;
    if (!Array.isArray(vp?.verifiableCredential)) return false;
    let expired = false;
    for (const credential of vp.verifiableCredential) {
      if (typeof credential !== 'string') return false;
      if (await isAuthenticExpiredCredential(credential)) expired = true;
      else await VerifiableCredential.verify({ vcJwt: credential });
    }
    return expired;
  } catch { return false; }
}
