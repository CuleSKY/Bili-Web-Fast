# Bilibili Web Fast Chrome浏览器扩展

## 简介

Bili Web Fast 用于解决海外B站网页端视频和直播播放卡顿的问题。这个代码100%由AI编写，仅为个人自用的小工具，不考虑上架扩展应用商店，请Clone仓库后自行编译。**若介意请勿使用**

---

## 如何使用

git clone 本项目
然后在本项目的根目录下依次执行
**要求 Node.js ≥ v20.19.0**

```
npm install
npm run build
```

编译后的扩展为dist-extension/
在Chrome扩展程序中启用开发者模式

点击**加载未打包的扩展程序**，选择编译后的dist-extension 文件夹即可
