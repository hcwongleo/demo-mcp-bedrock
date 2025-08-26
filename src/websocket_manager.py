# Minimal websocket_manager for compatibility
class ConnectionManager:
    def __init__(self):
        pass
    
    async def connect(self, websocket):
        pass
    
    def disconnect(self, websocket):
        pass
    
    async def send_personal_message(self, message, websocket):
        pass

connection_manager = ConnectionManager()
