# 小伟播客 - Hugging Face Spaces 部署镜像
# 保留本地 SQLite（零数据库迁移），仅用持久卷保存数据与上传音频
FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 原生模块编译所需的构建工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用 Docker 缓存层）
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 复制源码
COPY . .

ENV NODE_ENV=production
# Hugging Face 会注入 PORT（默认 7860），这里仅作兜底
EXPOSE 7860

CMD ["node", "server.js"]
