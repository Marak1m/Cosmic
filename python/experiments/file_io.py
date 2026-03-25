from datetime import datetime
import os

def save_markdown(task_output):
    """
    Saves the given task output to a markdown file named with today's date.

    Parameters:
    task_output (object): The output object from the task, expected to have a `result` attribute containing markdown content.

    Returns:
    None
    """
    try:
        # Get today's date in the format YYYY-MM-DD
        today_date = datetime.now().strftime('%Y-%m-%d')
        
        # Create the directory if it doesn't exist
        output_directory = "newsletters"
        if not os.path.exists(output_directory):
            os.makedirs(output_directory)
        
        # Set the filename with today's date inside the 'newsletters' directory
        filename = os.path.join(output_directory, f"{today_date}.md")
        
        # Check if task_output has the expected attribute
        if hasattr(task_output, 'result') and isinstance(task_output.result, str):
            # Write the task output to the markdown file
            with open(filename, 'w') as file:
                file.write(task_output.result)
            print(f"Newsletter saved as {filename}")
        else:
            print("Invalid task output. The 'result' attribute is missing or not a string.")
    except Exception as e:
        print(f"An error occurred while saving the markdown file: {e}")
