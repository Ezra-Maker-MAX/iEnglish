-- ============================================================
-- 语音功能：为场景绑定角色音色
-- 追加列，不影响原有数据
-- ============================================================
--
-- 音色分配原则
-- ------------
--   1) **性别必须与角色设定一致**（Max/Nico/Sam 男声，Momo/Ivy 女声）
--   2) **年龄感要与角色匹配** —— 社团场景的 Sam 是同龄小伙伴，用童声 Ana
--   3) **同性别角色之间要有区分度** —— 机场 Max 用沉稳的 Andrew（News 音色），
--      商店 Nico 用活泼的 Brian（Conversation 音色），孩子能听出「换人了」
--   4) **语速一律放慢** —— 这是给英语初学者听的，-10% 是实测比较舒服的值；
--      童声本身语速偏快，配合 -5% 更自然
--
-- 音色来自 edge-tts（免费、无需 Key），短名如 en-US-AndrewNeural

ALTER TABLE scenarios ADD COLUMN character_voice TEXT;
ALTER TABLE scenarios ADD COLUMN voice_rate TEXT DEFAULT '-10%';
ALTER TABLE scenarios ADD COLUMN voice_pitch TEXT DEFAULT '+0Hz';

-- ---------- 机场值机：Max（男性地勤，沉稳）----------
UPDATE scenarios
   SET character_voice = 'en-US-AndrewNeural',
       voice_rate      = '-12%',
       voice_pitch     = '+0Hz'
 WHERE slug = 'airport-checkin';

-- ---------- 商店比价：Nico（男性导购，热情话多）----------
UPDATE scenarios
   SET character_voice = 'en-US-BrianNeural',
       voice_rate      = '-8%',
       voice_pitch     = '+0Hz'
 WHERE slug = 'shop-compare';

-- ---------- 餐厅点餐：Momo（女性店员，温柔耐心）----------
UPDATE scenarios
   SET character_voice = 'en-US-JennyNeural',
       voice_rate      = '-12%',
       voice_pitch     = '+0Hz'
 WHERE slug = 'restaurant-order';

-- ---------- 即兴演讲：Ivy（女性教练，鼓励型）----------
UPDATE scenarios
   SET character_voice = 'en-US-AvaNeural',
       voice_rate      = '-8%',
       voice_pitch     = '+0Hz'
 WHERE slug = 'impromptu-speech';

-- ---------- 社团面试：Sam（同龄小伙伴，童声）----------
UPDATE scenarios
   SET character_voice = 'en-US-AnaNeural',
       voice_rate      = '-5%',
       voice_pitch     = '+0Hz'
 WHERE slug = 'club-interview';

-- ============================================================
-- 自检：确认 5 个场景都已绑定音色
-- ============================================================
-- SELECT slug, character_name, character_voice, voice_rate
--   FROM scenarios WHERE active = 1 ORDER BY sort_order;
