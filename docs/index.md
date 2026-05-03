---
layout: home

hero:
  name: CCG
  text: 三个 AI 协作，代码你看得见
  tagline: Codex 分析后端，Gemini 分析前端，Claude 写代码。全程透明，没有黑盒。
  image:
    src: /logo.svg
    alt: CCG
  actions:
    - theme: brand
      text: 三分钟上手
      link: /guide/getting-started
    - theme: alt
      text: 看看有哪些命令
      link: /guide/commands
    - theme: alt
      text: GitHub
      link: https://github.com/fengshao1227/ccg-workflow

features:
  - icon: 🔀
    title: 前端后端自动分流
    details: 你说"改登录页"，Gemini 分析方案；你说"加个接口"，Codex 分析方案。Claude 拿到分析结果后写代码——你能看到每一行改动。
  - icon: 🔒
    title: 代码透明，没有黑盒
    details: 默认模式下 Claude 写代码，你看得见过程。也可以用 codex-exec 让 Codex 写代码，最后 Claude + Gemini 多模型审查。怎么选都不是黑盒。
  - icon: 📐
    title: 不让 AI 自由发挥
    details: 集成 OPSX 规范驱动，需求先变成约束条件，AI 只能在框框里干活。
  - icon: 👥
    title: 多人干活，一起写
    details: Agent Teams 模式下，多个 Builder 同时写不同模块的代码，完了还有双模型交叉审查。
  - icon: ⚡
    title: 一行装完，开箱即用
    details: npx ccg-workflow，28 个命令直接可用。macOS、Linux、Windows 都行。
  - icon: 🧩
    title: MCP 生态打通
    details: ace-tool、fast-context、Context7 等 MCP 工具一键配置，Codex 和 Gemini 自动同步。
---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: -webkit-linear-gradient(120deg, #bd34fe 30%, #41d1ff);
  --vp-home-hero-image-background-image: linear-gradient(-45deg, #bd34fe50 50%, #47caff50 50%);
  --vp-home-hero-image-filter: blur(44px);
}

@media (min-width: 640px) {
  :root {
    --vp-home-hero-image-filter: blur(56px);
  }
}

@media (min-width: 960px) {
  :root {
    --vp-home-hero-image-filter: blur(68px);
  }
}
</style>
