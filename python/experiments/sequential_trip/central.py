# central_coordinator.py
from flask import Flask, request, jsonify
from collections import defaultdict

app = Flask(__name__)

# In-memory message storage for the two LLMs
messages = defaultdict(list)

@app.route('/send_message', methods=['POST'])
def send_message():
    data = request.json
    recipient = data['recipient']
    message = {
        'sender': data['sender'],
        'content': data['content'],
        'timestamp': data.get('timestamp')
    }
    messages[recipient].append(message)
    return jsonify({'status': 'Message sent successfully'}), 200

@app.route('/receive_messages/<recipient>', methods=['GET'])
def receive_messages(recipient):
    if recipient not in messages:
        return jsonify({'messages': []}), 200
    return jsonify({'messages': messages[recipient]}), 200

if __name__ == '__main__':
    app.run(port=5002)
