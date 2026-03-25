import asyncio
import autogen
import os
import httpx
from typing import Optional, List, Dict, Tuple, Union
import random  # noqa E402

import matplotlib.pyplot as plt  # noqa E402
import networkx as nx  # noqa E402

import autogen  # noqa E402
from autogen.agentchat.conversable_agent import ConversableAgent  # noqa E402
from autogen.agentchat.assistant_agent import AssistantAgent  # noqa E402
from autogen.agentchat.groupchat import GroupChat  # noqa E402
from autogen.graph_utils import visualize_speaker_transitions_dict 

# Set your OpenAI API key
os.environ["OPENAI_API_KEY"] = \"\"

# Define a custom HTTP client
class MyHttpClient(httpx.Client):
    def __deepcopy__(self, memo):
        return self

# Configure the language model
llm_config = {
    "config_list": [
        {
            "model": "llama3.1",
            "api_type": "ollama",
            "client_host": "http://44.221.48.158:11434",
        }
    ]
}

# Initialize agents
user_proxy = autogen.UserProxyAgent(
    name="User_proxy",
    system_message="A human admin.",
    code_execution_config={
        "last_n_messages": 2,
        "work_dir": "groupchat",
        "use_docker": False,
    },
    human_input_mode="TERMINATE",
)
Agent0 = autogen.AssistantAgent(
    name="Subject Matter Expert",
    system_message=(
        "You are responsible for providing detailed content and ensuring accuracy. "
        "Enhance the course outline with in-depth information."
    ),
    llm_config=llm_config,
)


Agent1 = autogen.AssistantAgent(
    name="Content Creator",
    system_message=(
        "You are responsible for developing engaging materials based on the curriculum and SME input. "
        "Create detailed content for each module."
    ),
    llm_config=llm_config,
)

Agent2 = autogen.AssistantAgent(
    name="Curriculum Planner",
    system_message=(
        "You are responsible for designing the course structure. "
        "Create a comprehensive outline for a digital marketing course."
    ),
    llm_config=llm_config,
)



agents = [ConversableAgent(name=f"Agent{i}", llm_config=False) for i in range(2)]
allowed_speaker_transitions_dict = {agent: [other_agent for other_agent in agents] for agent in agents}

visualize_speaker_transitions_dict(allowed_speaker_transitions_dict, agents)
# Initialize GroupChat and GroupChatManager
#groupchat = autogen.GroupChat(agents=[user_proxy, subject_matter_expert, content_creator, curriculum_planner], messages=[], max_round=12)
manager = autogen.GroupChatManager(groupchat=groupchat, llm_config=llm_config)

# Define the initial message
initial_message = "create a detailed course on digital marketting with modules and content with 15 modules for 15 weeks"

# Asynchronous function to get agent responses with retries
async def get_agent_reply(agent, msg: str) -> Optional[str]:
    # Loop to attempt message sending and receiving with retries
    for _ in range(4):
        await agent.a_send(message=msg, recipient=agent, request_reply=True, silent=False)
        latest = agent.last_message()
        if latest and 'content' in latest:
            content = latest['content']
            if content:
                return content
    return None

# Function to handle multiple agent responses in parallel
async def reply_func(agents, content: str) -> Tuple[bool, str]:
    tasks = [get_agent_reply(agent, content) for agent in agents if agent.name != "User_proxy"]
    results = await asyncio.gather(*tasks)
    
    # Combine results and filter out any None responses
    combined_responses = "\n".join(result for result in results if result)
    return True, combined_responses

# Main function to run the group chat
async def main():
    # User proxy initiates the chat
    user_proxy.initiate_chat(manager, message=initial_message)

    # Run the group chat with parallel agent responses
    for round_num in range(groupchat.max_round):
        if groupchat.messages:
            last_message = groupchat.messages[-1]
            if last_message and "content" in last_message:
                content = last_message["content"]

                # Execute parallel agent replies
                success, responses = await reply_func(groupchat.agents, content)
                
                # Display and append responses to group chat if successful
                if success:
                    print(responses)
                    groupchat.messages.append({"sender": "All Agents", "content": responses})

                # Check for termination condition
                if "TERMINATE" in responses:
                    break

# Run the main function
if __name__ == "__main__":
    asyncio.run(main())
