import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """基础配置"""
    SECRET_KEY = os.getenv('SECRET_KEY', 'default-secret-key')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_EXPIRATION_HOURS = int(os.getenv('JWT_EXPIRATION_HOURS', 24))

    # 数据库连接池配置（应对 PTZ 高频请求 + WebSocket 并发）
    # 注意: flask_sqlalchemy 3.x 必须用 SQLALCHEMY_ENGINE_OPTIONS 字典传递
    SQLALCHEMY_ENGINE_OPTIONS = {
        'pool_size': 20,
        'max_overflow': 30,
        'pool_timeout': 10,
        'pool_recycle': 3600,
    }

    # 文件上传
    UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'uploads')
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 最大上传 50MB

    # JSON 中文不乱码
    JSON_AS_ASCII = False


class DevelopmentConfig(Config):
    """开发环境配置"""
    DEBUG = True
    SQLALCHEMY_DATABASE_URI = os.getenv(
        'DATABASE_URL',
        'mysql+pymysql://root:claw@192.168.42.135:3306/images_annotate'
    )
    SQLALCHEMY_ECHO = True  # 打印 SQL 语句


class ProductionConfig(Config):
    """生产环境配置"""
    DEBUG = False
    SQLALCHEMY_DATABASE_URI = os.getenv('DATABASE_URL')
    SQLALCHEMY_ECHO = False


# 配置映射
config_map = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig,
}


def get_config():
    """获取当前环境配置"""
    env = os.getenv('FLASK_ENV', 'default')
    return config_map.get(env, config_map['default'])
