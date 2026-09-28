process.env.SETTINGS_SECRET = 'test-secret-for-verification-0123456789';
const crypto = await import('node:crypto');

function deriveKey() {
  return crypto.scryptSync(process.env.SETTINGS_SECRET, 'ienglish-settings-v1', 32);
}
function encryptValue(plain) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}
function decryptValue(stored) {
  const key = deriveKey();
  const parts = stored.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
  d.setAuthTag(Buffer.from(parts[3], 'base64'));
  return Buffer.concat([d.update(Buffer.from(parts[4], 'base64')), d.final()]).toString('utf8');
}

const plain = 'sk-test1234567890abcdefghijklmn';
const enc = encryptValue(plain);
console.log('原文        :', plain);
console.log('格式前缀    :', enc.split(':').slice(0, 2).join(':'));
console.log('密文总长    :', enc.length);
console.log('解密还原    :', decryptValue(enc));
console.log('往返一致    :', decryptValue(enc) === plain);
const enc2 = encryptValue(plain);
console.log('随机IV生效  :', enc2 !== enc);

// 篡改检测：GCM 认证标签应使其失败
try {
  const bad = enc.slice(0, -4) + 'AAAA';
  decryptValue(bad);
  console.log('篡改检测    : 失败（未拦截）');
} catch {
  console.log('篡改检测    : 通过（已拦截篡改）');
}
