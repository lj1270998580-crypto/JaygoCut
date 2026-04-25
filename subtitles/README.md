# videocut:subtitles

> subtitles生成与烧录

## 文件

| 文件 | 作用 |
|------|------|
| `SKILL.md` | 流程定义 |
| `dictionary.txt` | 正确写法列表（每行一个） |

## 词典格式

```
skills
Claude
钉钉AI录音卡
```

用户只写正确的词，我识别所有错误变体。

## 流程

```
转录 → 词典纠错 → 用户审核 → 烧录
```
