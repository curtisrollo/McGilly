from McGilly import dbbot
from McGilly import exercise
import time
import warnings

warnings.simplefilter(action='ignore', category=FutureWarning)


def main():


    # selects the city to search on soundcloud and scrape
    city, count = dbbot.read_csv()
    location = city[0]
    formatted_city = location.replace("%20", " ")
    length_of_list = count - len(city)
    print("--- " + formatted_city + " is being Scraped ---\n")

    # will do a search on soundcloud from city selected and scroll down for around a min.
    # It then pulls the page source and adds the artist's urls to queue to be scraped.
    queue = exercise.fetch_list(city)
    print('\n--- Queue established, scraping initialized ---\n')
    # artist info scraped
    link, name, email, email_csv = exercise.list_scrape(queue)

    # formats a csv file with info scraped appropriate for SendGrid
    dbbot.sendgrid_csv_prep(email_csv, formatted_city)
    print("--- Preparing csv for Sendgrid CSV ---")

    # creates csv and excel file of all data pulled
    dbbot.create_output_csv(formatted_city, link, name, email)
    print("--- CSV and Excel file saved ---")

    # checks off the city in the main database so there isn't duplicate searches
    dbbot.scrape_check(length_of_list)
    print("--- Checking off " + formatted_city + " ---")

    # uploads prepped csv to SendGrid
    #dbbot.add_csv_to_SendGrid(formatted_city)
    #print("--- CSV uploaded sucessfully ---")

    # displays length of time of program
    print("--- " + formatted_city + " finished scraping ---")


if __name__ == "__main__":
    print("--- Hi, I'm McGilly, ready to scrape the web? ---")
    time.sleep(10)
    mcgilly_time = time.time()
    main()
    # for i in range(1,10):
    #     tries = 3
    #     for j in range(tries):
    #         try:
    #             # to track the time
    #             start_time = time.time()
    #             main()
    #             # displays length of time of program
    #             print("--- %s seconds ---" % (time.time() - start_time))
    #         except Exception as e:
    #             if i < tries - 1:  # i is zero indexed
    #                 print("Error occured")
    #                 continue
    #             else:
    #                 raise
    #         break
    # for i in range(1,10):
    #     tries = 3
    #     for j in range(tries):
    #         try:
    #             # to track the time
    #             start_time = time.time()
    #             main()
    #             # displays length of time of program
    #             print("--- %s seconds ---" % (time.time() - start_time))
    #         except Exception as e:
    #             if i < tries - 1:  # i is zero indexed
    #                 print("Error occured")
    #                 continue
    #             else:
    #                 raise
    #         break
    print("--- %s seconds ---" % (time.time() - mcgilly_time))