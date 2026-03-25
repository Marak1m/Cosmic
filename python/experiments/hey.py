import asyncio
import autogen
import os
import httpx
from typing import Optional, List, Dict, Tuple, Union

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
            "client_host": "http://44.221.77.182:11434",
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
subject_matter_expert = autogen.AssistantAgent(
    name="Subject Matter Expert",
    system_message=(
        "You are responsible for providing detailed content and ensuring accuracy. "
        "Enhance the course outline with in-depth information."
    ),
    llm_config=llm_config,
)


content_creator = autogen.AssistantAgent(
    name="Content Creator",
    system_message=(
        "You are responsible for developing engaging materials based on the curriculum and SME input. "
        "Create detailed content for each module."
    ),
    llm_config=llm_config,
)

curriculum_planner = autogen.AssistantAgent(
    name="Curriculum Planner",
    system_message=(
        "You are responsible for designing the course structure. "
        "Create a comprehensive outline for a digital marketing course."
    ),
    llm_config=llm_config,
)

# Initialize GroupChat and GroupChatManager
groupchat = autogen.GroupChat(agents=[user_proxy, content_creator, subject_matter_expert, curriculum_planner], messages=[], max_round=12)
manager = autogen.GroupChatManager(groupchat=groupchat, llm_config=llm_config)

# Define the initial message
initial_message = "Design a course on digital marketing with modules and content."

# Asynchronous function to get agent responses with retries
async def get_agent_reply(agent, msg: str) -> Optional[str]:
    for _ in range(4):
        await agent.a_send(
            message=msg,
            recipient=agent,
            request_reply=True,
            silent=False
        )
        latest = agent.last_message()  # Corrected method call
        if latest and 'content' in latest:
            content = latest['content']
            if content:
                return content
    return None


# Function to handle multiple agent responses in parallel
def reply_func(
        agents,  # list of ConversableAgent
        messages: Optional[List[Dict]] = None,
) -> Tuple[bool, Union[str, Dict, None]]:
    last_message = messages[-1] if messages else None
    if last_message and "content" in last_message:
        # Extract the content from the last message
        content = last_message["content"]

        # Create a new asyncio event loop for executing tasks
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        # Initialize asynchronous tasks for each agent reply
        tasks = [get_agent_reply(agent, content) for agent in agents if agent.name != "User_proxy"]

        # Run tasks concurrently and retrieve results
        results = loop.run_until_complete(asyncio.gather(*tasks))
        
        # Close the event loop after completion
        loop.close()

        # Return the results combined as a single string
        combined_responses = "\n".join(result for result in results if result)
        return True, combined_responses

    # If there is no valid last message, return False
    return False, None

# Main function to run the group chat
async def main():
    # User proxy initiates the chat
    user_proxy.initiate_chat(manager, message=initial_message)

    # Run the group chat with parallel agent responses
    for round_num in range(groupchat.max_round):
        if groupchat.messages:
            success, responses = reply_func(groupchat.agents, groupchat.messages)
            
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
