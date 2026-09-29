-- ============================================================
-- 场景游戏化改造（第一期样板：机场任务）
-- 为 scenarios 表补充「性格 / 事件 / 目标」三类字段
-- ============================================================

-- 角色性格：AI 说话的语气设定，决定它是否有情绪、会吐槽、爱开玩笑
ALTER TABLE scenarios ADD COLUMN character_name TEXT;
ALTER TABLE scenarios ADD COLUMN character_persona TEXT;

-- 开局氛围：一句话把孩子拉进情境，比"Welcome to the airport"有代入感
ALTER TABLE scenarios ADD COLUMN hook_line TEXT;

-- 突发事件：JSON 数组。对话进行到一定轮次时抛出，制造戏剧性
-- [{"at_turn":2,"event":"行李超重了","ai_hint":"露出为难的表情，让孩子想办法"}, ...]
ALTER TABLE scenarios ADD COLUMN events TEXT;

-- 任务目标：JSON 数组。孩子需要完成的关卡，用于界面显示进度
-- [{"id":"t1","label":"拿到登机牌"},{"id":"t2","label":"通过安检"}]
ALTER TABLE scenarios ADD COLUMN missions TEXT;

-- 成功反馈：完成一个任务时的即时表扬（英文，简短有情绪）
ALTER TABLE scenarios ADD COLUMN praise_lines TEXT;

-- 结局奖励：整场结束后的称号与徽章
ALTER TABLE scenarios ADD COLUMN reward_badge TEXT;
ALTER TABLE scenarios ADD COLUMN reward_title TEXT;
