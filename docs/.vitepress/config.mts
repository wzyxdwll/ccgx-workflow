import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'CCG',
  description: 'Claude + Codex + Gemini 多模型协作开发系统',

  base: '/ccg-workflow/',
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/ccg-workflow/logo.svg' }],
  ],

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '指南', link: '/guide/getting-started' },
          { text: '命令', link: '/guide/commands' },
          {
            text: '更多',
            items: [
              { text: '工作流', link: '/guide/workflows' },
              { text: 'MCP 配置', link: '/guide/mcp' },
              { text: '配置', link: '/guide/configuration' },
            ],
          },
        ],
        sidebar: [
          {
            text: '入门',
            items: [
              { text: '快速开始', link: '/guide/getting-started' },
              { text: '命令参考', link: '/guide/commands' },
            ],
          },
          {
            text: '进阶',
            items: [
              { text: '工作流指南', link: '/guide/workflows' },
              { text: 'MCP 配置', link: '/guide/mcp' },
              { text: '配置说明', link: '/guide/configuration' },
            ],
          },
        ],
        editLink: {
          pattern: 'https://github.com/fengshao1227/ccg-workflow/edit/main/docs/:path',
          text: '在 GitHub 上编辑此页',
        },
        footer: {
          message: '基于 MIT 许可发布',
          copyright: 'Copyright © 2025-present CCG Contributors',
        },
        docFooter: {
          prev: '上一页',
          next: '下一页',
        },
        outline: {
          label: '页面导航',
        },
        lastUpdated: {
          text: '最后更新于',
        },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      description: 'Claude + Codex + Gemini Multi-Model Collaboration System',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/guide/getting-started' },
          { text: 'Commands', link: '/en/guide/commands' },
          {
            text: 'More',
            items: [
              { text: 'Workflows', link: '/en/guide/workflows' },
              { text: 'MCP Config', link: '/en/guide/mcp' },
              { text: 'Configuration', link: '/en/guide/configuration' },
            ],
          },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: 'Quick Start', link: '/en/guide/getting-started' },
              { text: 'Command Reference', link: '/en/guide/commands' },
            ],
          },
          {
            text: 'Advanced',
            items: [
              { text: 'Workflow Guide', link: '/en/guide/workflows' },
              { text: 'MCP Configuration', link: '/en/guide/mcp' },
              { text: 'Configuration', link: '/en/guide/configuration' },
            ],
          },
        ],
        editLink: {
          pattern: 'https://github.com/fengshao1227/ccg-workflow/edit/main/docs/:path',
          text: 'Edit this page on GitHub',
        },
        footer: {
          message: 'Released under the MIT License',
          copyright: 'Copyright © 2025-present CCG Contributors',
        },
      },
    },
  },

  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/fengshao1227/ccg-workflow' },
    ],
    search: {
      provider: 'local',
    },
  },
})
