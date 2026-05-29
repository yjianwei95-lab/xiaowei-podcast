FROM node:20-slim

WORKDIR /app

# 安装依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 复制代码
COPY . .

# 创建上传目录
RUN mkdir -p uploads

# 暴露端口
EXPOSE 3000

# 启动
CMD ["node", "server.js"]
