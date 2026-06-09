import os
from dotenv import load_dotenv

# gevent monkey-patch 必须在其他 import 之前
from gevent import monkey
monkey.patch_all()

from app import create_app
from app.extensions import socketio

# 加载环境变量
load_dotenv()

# 创建应用
app = create_app()

if __name__ == '__main__':
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', 5000))
    debug = os.getenv('FLASK_DEBUG', 'True').lower() == 'true'

    print(f"""
╔══════════════════════════════════════════════════╗
║     Flask CKiko-Admin API Server                ║
║     Running on: http://{host}:{port}                ║
║     Environment: {os.getenv('FLASK_ENV', 'development')}                     ║
║     Debug: {debug}                                ║
║     WebSocket: ws://{host}:{port}                   ║
╚══════════════════════════════════════════════════╝
    """)

    socketio.run(app, host=host, port=port, debug=debug, allow_unsafe_werkzeug=True, use_reloader=False)
