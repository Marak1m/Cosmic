# filename: google_scholar_search.py
import google.search as gsearch

def search_google_scholar():
    try:
        results = gsearch.search('gpt-4', site='scholar.google.com')
        
        # Print the first paper that contains 'gpt-4' in its title or abstract
        for result in results:
            if 'gpt-4' in result.title.lower() or 'gpt-4' in result.description.lower():
                print(f"Title: {result.title}")
                print(f"URL: {result.link}")
                return
                
        print("No papers found on Google Scholar about GPT-4.")
        
    except Exception as e:
        print(f"An error occurred: {e}")

search_google_scholar()