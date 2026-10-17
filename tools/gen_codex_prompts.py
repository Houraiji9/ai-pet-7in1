#!/usr/bin/env python3
"""Generate per-image Codex prompt packs for ai-pet-7in1 animation assets.

Excludes DeepSeek (original project already has those animations).
Usage:
  python tools/gen_codex_prompts.py [OUTPUT_DIR]

Default OUTPUT_DIR is ./桌宠动画生成 relative to cwd.
Copies reference images from design/ref-fanworks and design/gpt/codex-idle.png
when those paths exist next to the repo root.
"""
from __future__ import annotations

import glob
import os
import shutil
import sys

# Action name -> English pose description (ported from original DeepSeek set)
ACTIONS = {
    "三球抛接": "juggling three small colorful balls in the air above her hands",
    "下五子棋": "sitting and placing a stone on a small gomoku board, thinking",
    "东张西望": "looking around curiously, head turned to one side, hand shading eyes",
    "中秋赏月吃月饼": "holding a mooncake and gazing up at a full moon",
    "优雅女仆舞": "doing an elegant maid-style dance spin, skirt flaring",
    "余额-分文不剩": "turning out empty pockets, crying comically, completely broke",
    "余额-数金皱眉": "counting a few gold coins in her palm with a worried frown",
    "余额-袋空如洗": "holding a flat empty coin pouch upside down, sad",
    "余额-金袋叮当": "happily jingling a small coin bag",
    "余额-钱袋如常": "holding a normal coin pouch calmly, content",
    "余额-钱袋满溢": "hugging a huge overflowing bag of gold coins, delighted",
    "偷吃零食被抓住": "caught sneaking a snack, cookie in mouth, startled guilty look",
    "写代码": "typing on a small laptop, focused",
    "写福字": "writing the Chinese character 福 with a big brush on red paper",
    "凭空生花": "conjuring a flower blooming from her open palm",
    "动物环绕": "surrounded by small cute animals (bunny, bird, kitten), smiling",
    "原地专心玩魔方": "concentrating on solving a Rubik cube",
    "原地小憩沉眠": "sitting and sleeping peacefully, head nodding, small Zzz",
    "原地左转奔跑": "SIDE VIEW running toward the LEFT side of the image, fast stride",
    "原地敲击桌面互动": "leaning forward and tapping on an invisible surface (the screen) with both hands",
    "原地漂浮踏步": "floating slightly above ground, stepping in the air",
    "原地跳跃抓碎头顶物品": "jumping up to grab a small object above her head",
    "原地蹲下玩玩具汽车": "squatting and pushing a small toy car",
    "原地重力下蹲压缩": "squashed into a crouch as if pressed by heavy gravity, comical",
    "变鸽子": "magician pose, a white dove flying out of her hands",
    "可爱宅舞": "doing a cute otaku idol dance pose, hands making heart shape",
    "吃Token": "happily eating a glowing coin-shaped token like a cookie",
    "吃冰淇淋融化": "licking an ice cream cone that is melting, panicking slightly",
    "吃午餐": "eating lunch from a bento box with chopsticks",
    "吃大闸蟹": "cracking and eating a hairy crab",
    "吃年糕": "eating a stretchy rice cake (niangao)",
    "吃早餐": "eating breakfast, toast and a glass of milk",
    "吃晚餐": "eating dinner from a bowl with chopsticks",
    "吃汤圆": "eating tangyuan from a small bowl with a spoon",
    "吃白饭": "eating plain white rice from a bowl, slightly sad",
    "吃粽子": "unwrapping and eating a zongzi",
    "吃糖葫芦": "eating a tanghulu candied haws stick",
    "吃腊八粥": "eating laba porridge from a bowl",
    "吃西瓜": "eating a big slice of watermelon",
    "吃重阳糕": "eating a chongyang cake",
    "吃长寿面": "slurping long noodles from a bowl",
    "吃青团": "eating a green qingtuan rice ball",
    "吃饺子": "eating dumplings with chopsticks",
    "吹气球": "blowing up a balloon, cheeks puffed",
    "吹笛子": "playing a bamboo flute",
    "哈欠连天": "big yawn, stretching one arm, sleepy eyes",
    "堆雪人": "building a small snowman",
    "大口吃零食": "munching a big bag of snacks happily",
    "女仆屈膝礼仪": "doing an elegant maid curtsy, holding skirt edges",
    "小幅度原地360度旋转展示": "mid-spin turning around showing her outfit from three-quarter back view",
    "小提琴演奏": "playing a violin",
    "工作状态-原地踱步张望": "pacing and looking around while waiting",
    "工作状态-垂头叹气冒汗": "head drooping, sighing, sweat drop, tired from work",
    "工作状态-忙碌点按": "busily tapping on a floating tablet",
    "工作状态-思考冒泡": "thinking with hand on chin, thought bubble above head",
    "工作状态-清点归档": "sorting and filing a stack of papers into folders",
    "工作状态-雀跃庆祝": "jumping with joy celebrating, arms raised",
    "待机呼吸休闲": "relaxed idle standing pose, gentle smile",
    "悠闲哼歌": "humming a tune, eyes closed, music notes around",
    "扑克魔术": "fanning a hand of playing cards, magic trick",
    "打瞌睡被惊醒": "dozing then jolting awake, startled",
    "抽陀螺": "whipping a spinning top on the ground",
    "拆礼物": "opening a wrapped gift box, excited",
    "插茱萸赏菊": "wearing a dogwood sprig, admiring chrysanthemums",
    "摇扇纳凉": "fanning herself with a round fan, cooling off",
    "撸猫": "petting a cat in her arms",
    "收红包": "receiving a red envelope with both hands, delighted",
    "放孔明灯": "releasing a sky lantern",
    "放河灯": "placing a lotus lantern on water",
    "放烟花": "holding a sparkler, fireworks behind",
    "放风筝": "flying a kite on a string",
    "整体换装试色": "trying a different outfit color, posing",
    "是啊，吃什么": "pondering what to eat, hand on chin, food icons in bubble",
    "晨间刷牙": "brushing teeth, foam on mouth, sleepy",
    "涮火锅": "dipping meat into a small hotpot with chopsticks",
    "深度思考碎碎念": "deep thinking, muttering, swirls above head",
    "点击回应-傲娇生气": "tsundere angry pout, arms crossed, looking away",
    "点击回应-元气挥手": "energetic big wave with a bright smile",
    "点击回应-害羞惊讶": "shy and surprised, hands near cheeks, blushing",
    "点击回应-开心跃动": "happy little jump, arms up",
    "点击回应-挠痒咯咯笑": "giggling as if tickled, squirming",
    "照镜子": "looking into a hand mirror, fixing hair",
    "玩水枪": "shooting a water gun, playful",
    "玩游戏气急败坏": "holding a game controller, furious after losing",
    "用鲸鱼尾巴拍打地面": "slapping the ground playfully with her tail (or stomping if no tail)",
    "碎碎念-发呆碎碎念": "spacing out muttering, blank stare",
    "碎碎念-对屏碎碎念": "leaning toward the viewer talking, small speech marks",
    "碎碎念-擦桌碎碎念": "wiping a surface with a cloth while muttering",
    "穿针乞巧": "threading a needle carefully",
    "舞狮头": "holding up a small lion dance head",
    "荡秋千": "sitting on a swing",
    "萌化小幽灵": "wearing a cute ghost sheet costume",
    "蓝鲸现世": "a small cute blue whale appears floating beside her, she is amazed",
    "蝴蝶蜜蜂环绕头顶开花": "flowers blooming on her head with butterflies and bees circling",
    "螃蟹走路": "walking sideways like a crab, hands as claws",
    "被吓一跳": "jumping back startled, eyes wide",
    "被落叶淹没": "half buried in a pile of autumn leaves",
    "被鼠标拖拽悬空反馈": "being lifted up by an invisible hand from the back of her collar, legs dangling, flailing, flustered sweat drop, no hand visible",
    "装点圣诞树": "decorating a small Christmas tree",
    "讨糖南瓜灯": "holding a pumpkin lantern bucket, trick or treat",
    "超大伸懒腰": "huge stretch with arms high above head",
    "踢毽子": "kicking a shuttlecock with her foot",
    "轻快摇摆舞": "light swaying dance",
    "轻快记录": "cheerfully writing notes on a clipboard",
    "骑木马": "riding a small rocking horse",
    "鲸鱼吐泡泡特效": "blowing bubbles, bubbles floating around",
    "登场-星光现身": "cheerful greeting pose as if just appearing, one hand waving high, small star sparkles around (not touching edges)",
    "眨眼-待机收尾": "same idle pose but eyes gently closed in a blink",
}

# Per-role signature actions (brand motifs). DeepSeek excluded from generation.
SIGNATURE = {
    "gpt": [
        ("专属-展翅飞起", "flapping her dragon wings and lifting off the ground"),
        ("专属-光球魔法", "holding a glowing magic orb with the OpenAI knot symbol"),
        ("专属-龙息火花", "puffing a tiny cute sparkle breath like a baby dragon"),
        ("专属-尾巴卷成团睡", "curled up napping wrapped in her own fluffy tail"),
        ("专属-画画生图", "painting on a small easel, finished picture appearing"),
        ("专属-对话气泡", "surrounded by chat speech bubbles, answering happily"),
    ],
    "claude": [
        ("专属-浇灌向日葵", "watering a sunflower with a small watering can"),
        ("专属-长文卷轴", "unrolling a very long scroll of writing, proud"),
        ("专属-星芒标志旋转", "holding up a spinning orange starburst symbol"),
        ("专属-礼貌思考", "polite bow while thinking carefully, hand on chest"),
        ("专属-搭积木代码", "stacking glowing code blocks like building blocks"),
        ("专属-读书", "reading a thick book calmly"),
    ],
    "gemini": [
        ("专属-双子星光", "two sparkling stars orbiting her, twin constellation motif"),
        ("专属-捧宝石", "holding up a shining gem in both hands"),
        ("专属-拍照识图", "holding a camera, snapping a photo"),
        ("专属-四色光环", "surrounded by a ring of blue red yellow green light"),
        ("专属-星空遥望", "pointing up at constellations"),
        ("专属-分身", "a translucent twin copy of herself appearing beside her"),
    ],
    "glm": [
        ("专属-狐狸尾巴摇", "swishing a fluffy fox tail playfully, fox ears perked"),
        ("专属-狐火", "summoning small blue foxfire flames around her"),
        ("专属-变狐狸", "puff of smoke turning into a little fox"),
        ("专属-翻阅资料", "flipping through floating documents rapidly"),
        ("专属-画符", "drawing a glowing talisman in the air"),
        ("专属-蜷缩打盹", "curled up napping like a fox"),
    ],
    "kimi": [
        ("专属-坐月亮", "sitting on a crescent moon"),
        ("专属-超长文档", "reading an extremely long paper scroll piling on the floor"),
        ("专属-摘星星", "reaching up to pick a small star"),
        ("专属-月光下", "bathing in moonlight, peaceful"),
        ("专属-登月火箭", "riding a small toy rocket toward the moon"),
        ("专属-兔子陪伴", "hugging a small moon rabbit"),
    ],
    "grok": [
        ("专属-坐火箭", "riding a small rocket, excited"),
        ("专属-黑洞", "a tiny swirling black hole in her palm"),
        ("专属-坏笑吐槽", "smug sarcastic smirk, hand covering mouth"),
        ("专属-X标志", "posing with a big X symbol"),
        ("专属-太空漂浮", "floating in zero gravity with small planets around"),
        ("专属-星系", "holding a tiny spiral galaxy"),
    ],
}

# Whale-themed DeepSeek exclusives — strip from non-DeepSeek roles
WHALE_ACTIONS = ["用鲸鱼尾巴拍打地面", "蓝鲸现世", "鲸鱼吐泡泡特效"]

# Roles to generate (DeepSeek excluded — original assets already exist)
ROLES = [
    ("gpt", "ChatGPT-Chibi.png"),
    ("claude", "Claude-Chibi.png"),
    ("gemini", "Gemini-Chibi.png"),
    ("glm", "GLM-Chibi.png"),
    ("kimi", "Kimi-Chibi.png"),
    ("grok", "Grok-Chibi.png"),
]

BG = (
    "Full body, portrait canvas 576x1024, character centered with feet near the bottom "
    "(same scale as the model sheet), solid flat pure #00FF00 green background, no shadow, "
    "no ground, no text, no extra objects except props named here."
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def write_prompt(path: str, body: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


def copy_refs(out_dir: str) -> None:
    ref_dst = os.path.join(out_dir, "参考图")
    os.makedirs(ref_dst, exist_ok=True)
    fanworks = os.path.join(REPO_ROOT, "design", "ref-fanworks")
    if os.path.isdir(fanworks):
        for name in os.listdir(fanworks):
            src = os.path.join(fanworks, name)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(ref_dst, name))
    gpt_idle = os.path.join(REPO_ROOT, "design", "gpt", "codex-idle.png")
    if os.path.isfile(gpt_idle):
        shutil.copy2(gpt_idle, os.path.join(ref_dst, "GPT-定稿-idle.png"))


def generate(out_dir: str) -> int:
    out_dir = os.path.abspath(out_dir)
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(os.path.join(out_dir, "参考图"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "指令"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "输出"), exist_ok=True)
    copy_refs(out_dir)

    n = 0
    for i, (role, ref) in enumerate(ROLES, 1):
        rd = os.path.join(out_dir, "指令", f"{i:02d}-{role}")
        os.makedirs(rd, exist_ok=True)
        os.makedirs(os.path.join(out_dir, "输出", role), exist_ok=True)
        model = "参考图/GPT-定稿-idle.png" if role == "gpt" else f"输出/{role}/000-定稿.png"

        if role != "gpt":
            write_prompt(
                os.path.join(rd, "000-定稿.md"),
                f"附图：参考图/{ref}\n保存到：输出/{role}/000-定稿.png\n\n"
                f"Use your built-in image generation tool to create ONE image. "
                f"Redraw the attached chibi character as faithfully as possible "
                f"(same face, hair, eye color, accessories, logo ornaments, outfit, "
                f"wings/tail/ears, art style and chibi proportions). Only change: "
                f"neutral standing idle pose facing viewer, hands relaxed in front, "
                f"no props, no effects. {BG} Save it to 输出/{role}/000-定稿.png\n",
            )
            n += 1

        actions = {k: v for k, v in ACTIONS.items() if k not in WHALE_ACTIONS}
        for j, (name, desc) in enumerate(actions.items(), 1):
            safe = name.replace("，", "_")
            write_prompt(
                os.path.join(rd, f"{j:03d}-{safe}.md"),
                f"附图：{model}（模型稿）和 参考图/{ref}（原版设计）\n"
                f"保存到：输出/{role}/{j:03d}-{name}.png\n\n"
                f"Use your built-in image generation tool to create ONE image. "
                f"Using the first attached image as the exact character model sheet "
                f"(second image is the original design), draw the SAME chibi character "
                f"with identical face, hair, eye color, accessories, logo ornaments, "
                f"outfit, wings/tail/ears and art style, now {desc}. {BG} "
                f"Save it to 输出/{role}/{j:03d}-{name}.png\n",
            )
            n += 1

        for j, (name, desc) in enumerate(SIGNATURE.get(role, []), 201):
            write_prompt(
                os.path.join(rd, f"{j:03d}-{name}.md"),
                f"附图：{model}（模型稿）和 参考图/{ref}（原版设计）\n"
                f"保存到：输出/{role}/{j:03d}-{name}.png\n\n"
                f"Use your built-in image generation tool to create ONE image. "
                f"Using the first attached image as the exact character model sheet "
                f"(second image is the original design), draw the SAME chibi character "
                f"with identical face, hair, eye color, accessories, logo ornaments, "
                f"outfit, wings/tail/ears and art style, now {desc}. {BG} "
                f"Save it to 输出/{role}/{j:03d}-{name}.png\n",
            )
            n += 1

    guide = os.path.join(out_dir, "给Codex的话.txt")
    with open(guide, "w", encoding="utf-8") as f:
        f.write(
            "每次只做一张：\n"
            "1. 打开 指令/ 下按顺序的下一个 .md 文件（先 01-gpt，再 02-claude…，每个文件夹内按编号从小到大）。\n"
            "2. 如果文件里写的“保存到”路径已经有图了，就跳过这个文件。\n"
            "3. 否则按文件内容附图并生图，保存到写明的路径。失败就把文件名写进 输出/errors.txt。\n"
            "4. 做完立刻处理下一个文件，不要问我，直到全部完成。\n"
            "注意：除 gpt 外，每个角色必须先做 000-定稿，后面的图都以它为模型稿。\n"
            "不含 DeepSeek：原版动画已有，不必重做。\n"
        )

    md_count = sum(len(fs) for _, _, fs in os.walk(os.path.join(out_dir, "指令")))
    print(f"Wrote {md_count} prompt files ({n} generated) to {out_dir}")
    return md_count


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "桌宠动画生成")
    generate(out)


if __name__ == "__main__":
    main()
